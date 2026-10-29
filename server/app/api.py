from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from . import auth, prefs, runner, services
from .auth import COOKIE, require_admin, require_editor, require_user
from .config import settings
from .db import SessionLocal, get_session
from .hub import AgentOffline, hub
from .makefile import NAME_RE, VALUE_RE, VAR_RE, ModelError, to_makefile, validate_model
from .templates import BY_ID as TEMPLATES_BY_ID, TEMPLATES
from .models import AgentKey, AuditLog, Run, RunLog, RunStep, Server, Service, User, iso

router = APIRouter(prefix="/api")
Member = Depends(require_user)  # 로그인한 사용자 누구나
Editor = Depends(require_editor)  # 편집자·관리자 (Makefile·yaml 수정)
Admin = Depends(require_admin)  # 관리자만 (서버 추가·삭제, 설정, 사용자 관리)


# ------------------------------------------------------------------ 로그인
class LoginIn(BaseModel):
    username: str
    password: str


class OtpLoginIn(BaseModel):
    ticket: str
    code: str


def _set_session(response: Response, user: User) -> None:
    response.set_cookie(COOKIE, auth.make_session(user), httponly=True, samesite="strict", secure=settings.cookie_secure,
                        max_age=auth.SESSION_SECONDS)


def _client_key(request: Request) -> str:
    return request.client.host if request.client else "-"


@router.post("/login")
async def login(body: LoginIn, request: Request, response: Response) -> dict:
    """비밀번호 확인. 2단계 인증을 켠 계정이면 쿠키 대신 5분짜리 표(ticket)를 주고 /login/otp 에서 코드를 받는다."""
    key = _client_key(request)
    if not auth.login_allowed(key):
        raise HTTPException(429, "로그인 실패가 많습니다. 10분 뒤에 다시 시도하세요")
    async with SessionLocal() as s:
        u = (await s.execute(select(User).where(User.username == body.username.strip()))).scalar_one_or_none()
    # 없는 아이디여도 같은 시간이 걸리도록 비밀번호 확인은 항상 한다
    ok = auth.verify_password(body.password, u.password_hash if u else auth.hash_password("-"))
    if not (u and ok):
        auth.login_failed(key)
        raise HTTPException(401, "아이디 또는 비밀번호가 올바르지 않습니다")
    if u.totp_secret:
        return {"ok": False, "otp_required": True, "ticket": auth.make_ticket(u)}
    auth.login_ok(key)
    _set_session(response, u)
    return {"ok": True}


@router.post("/login/otp")
async def login_otp(body: OtpLoginIn, request: Request, response: Response) -> dict:
    key = _client_key(request)
    if not auth.login_allowed(key):
        raise HTTPException(429, "로그인 실패가 많습니다. 10분 뒤에 다시 시도하세요")
    t = auth.parse_ticket(body.ticket)
    if not t:
        raise HTTPException(401, "시간이 지났습니다. 처음부터 다시 로그인하세요")
    async with SessionLocal() as s:
        u = await s.get(User, t[0])
        if not u or u.session_ver != t[1] or not auth.verify_second_factor(u, body.code):
            auth.login_failed(key)
            raise HTTPException(401, "인증 코드가 올바르지 않습니다")
        await s.commit()  # 쓴 코드 기록
        auth.login_ok(key)
        _set_session(response, u)
        return {"ok": True, "recovery_left": auth.recovery_left(u)}


@router.post("/logout")
async def logout(response: Response) -> dict:
    response.delete_cookie(COOKIE)
    response.delete_cookie(auth.ELEVATED_COOKIE)
    return {"ok": True}


@router.get("/me")
async def me(request: Request) -> dict:
    u = await auth.current_user(request, allow_setup=True)
    return {"user": u.username, "name": u.name or u.username, "admin": u.is_admin, "edit": u.editor, "account": u.id is not None,
            "otp": {"enabled": u.otp_enabled, "required": u.otp_required, "setup_required": u.otp_setup_required},
            "elevated_until": auth.elevated_until(request, u)}


class PasswordIn(BaseModel):
    current: str
    new: str


async def _my_account(request: Request) -> auth.CurrentUser:
    cur = await auth.current_user(request, allow_setup=True)
    if cur.id is None:
        raise HTTPException(409, "관리자 토큰으로는 할 수 없습니다. 계정으로 로그인하세요")
    return cur


@router.put("/me/password")
async def change_my_password(body: PasswordIn, request: Request, response: Response) -> dict:
    cur = await _my_account(request)
    auth.check_password_rules(None, body.new)
    async with SessionLocal() as s:
        u = await s.get(User, cur.id)
        if not u or not auth.verify_password(body.current, u.password_hash):
            raise HTTPException(422, "현재 비밀번호가 올바르지 않습니다")
        u.password_hash = auth.hash_password(body.new)
        u.session_ver += 1  # 다른 기기의 로그인은 끊고, 이 기기는 새 쿠키로 이어간다
        await s.commit()
        _set_session(response, u)
    return {"ok": True}


class ReauthIn(BaseModel):
    code: str = ""
    password: str = ""


@router.post("/me/reauth")
async def reauth(body: ReauthIn, request: Request, response: Response) -> dict:
    """민감한 동작(환경변수 보기·수정) 전에 다시 인증한다. 2단계 인증을 쓰면 코드, 아니면 비밀번호. 10분 유지."""
    cur = await _my_account(request)
    key = _client_key(request)
    if not auth.login_allowed(key):
        raise HTTPException(429, "실패가 많아 10분 동안 할 수 없습니다")
    async with SessionLocal() as s:
        u = await s.get(User, cur.id)
        ok = auth.verify_second_factor(u, body.code) if u.totp_secret else auth.verify_password(body.password, u.password_hash)
        if not ok:
            auth.login_failed(key)
            raise HTTPException(401, "인증 코드가 올바르지 않습니다" if u.totp_secret else "비밀번호가 올바르지 않습니다")
        await s.commit()  # 쓴 코드 기록
        response.set_cookie(auth.ELEVATED_COOKIE, auth.make_elevation(u), httponly=True, samesite="strict",
                            secure=settings.cookie_secure, max_age=auth.ELEVATED_SECONDS)
    await auth.audit(request, cur.username, "reauth", "")
    return {"until": int(time.time()) + auth.ELEVATED_SECONDS}


@router.get("/audit")
async def audit_log(limit: int = 200, user: str = Admin, s: AsyncSession = Depends(get_session)) -> list[dict]:
    rows = (await s.execute(select(AuditLog).order_by(AuditLog.id.desc()).limit(min(limit, 1000)))).scalars().all()
    return [{"id": r.id, "at": iso(r.at), "user": r.user, "action": r.action, "target": r.target, "ip": r.ip} for r in rows]


# ------------------------------------------------------------------ 2단계 인증 등록·해제
class CodeIn(BaseModel):
    code: str


@router.post("/me/otp/setup")
async def otp_setup(request: Request) -> dict:
    """새 비밀값을 만들어 QR 로 보여 준다. 코드를 한 번 맞혀야(/enable) 켜진다."""
    import segno  # 등록할 때만 쓴다

    cur = await _my_account(request)
    async with SessionLocal() as s:
        u = await s.get(User, cur.id)
        u.totp_pending = auth.new_otp_secret()
        await s.commit()
        uri = auth.otp_uri(u.totp_pending, u.username)
        return {"secret": u.totp_pending, "uri": uri, "qr": segno.make(uri, error="m").svg_data_uri(scale=5, border=2)}


@router.post("/me/otp/enable")
async def otp_enable(body: CodeIn, request: Request, response: Response) -> dict:
    cur = await _my_account(request)
    async with SessionLocal() as s:
        u = await s.get(User, cur.id)
        step = auth.check_otp(u.totp_pending, body.code) if u.totp_pending else None
        if step is None:
            raise HTTPException(422, "코드가 맞지 않습니다. 앱에 보이는 6자리를 다시 입력하세요")
        u.totp_secret, u.totp_pending, u.totp_last_step = u.totp_pending, "", step
        codes = auth.new_recovery_codes(u)
        u.session_ver += 1  # 다른 기기의 로그인은 끊는다 (그쪽은 2단계 인증 없이 들어온 세션)
        await s.commit()
        _set_session(response, u)
    return {"recovery_codes": codes}


@router.post("/me/otp/disable")
async def otp_disable(body: CodeIn, request: Request) -> dict:
    cur = await _my_account(request)
    if cur.otp_required:
        raise HTTPException(409, "관리자와 편집자는 2단계 인증을 끌 수 없습니다")
    async with SessionLocal() as s:
        u = await s.get(User, cur.id)
        if not auth.verify_second_factor(u, body.code):
            raise HTTPException(422, "인증 코드가 올바르지 않습니다")
        u.totp_secret, u.recovery_codes = "", ""
        await s.commit()
    return {"ok": True}


@router.post("/me/otp/recovery")
async def otp_new_recovery(body: CodeIn, request: Request) -> dict:
    """복구 코드를 새로 만든다 (이전 코드는 모두 무효)."""
    cur = await _my_account(request)
    async with SessionLocal() as s:
        u = await s.get(User, cur.id)
        if not u.totp_secret or not auth.verify_second_factor(u, body.code):
            raise HTTPException(422, "인증 코드가 올바르지 않습니다")
        codes = auth.new_recovery_codes(u)
        await s.commit()
    return {"recovery_codes": codes}


# ------------------------------------------------------------------ 사용자 관리 (관리자)
ROLES = ("run", "edit", "admin")


def _user_dict(u: User) -> dict:
    return {"id": u.id, "username": u.username, "name": u.name or "", "role": auth.role_of(u), "admin": bool(u.is_admin),
            "otp": bool(u.totp_secret), "created_at": iso(u.created_at)}


class UserIn(BaseModel):
    username: str
    password: str
    name: str = ""
    role: str = "run"  # run: 보기·실행, edit: + Makefile·yaml 편집, admin: + 서버·사용자·설정


class UserPatch(BaseModel):
    password: str | None = None
    name: str | None = None
    role: str | None = None
    reset_otp: bool = False


async def _admin_count(s: AsyncSession) -> int:
    return (await s.execute(select(func.count()).select_from(User).where(User.is_admin.is_(True)))).scalar_one()


def _check_role(role: str) -> None:
    if role not in ROLES:
        raise HTTPException(422, "권한은 run, edit, admin 중 하나입니다")


@router.get("/users")
async def list_users(user: str = Admin, s: AsyncSession = Depends(get_session)) -> list[dict]:
    return [_user_dict(u) for u in (await s.execute(select(User).order_by(User.id))).scalars()]


@router.post("/users")
async def create_user(body: UserIn, user: str = Admin, s: AsyncSession = Depends(get_session)) -> dict:
    name = body.username.strip()
    auth.check_password_rules(name, body.password)
    _check_role(body.role)
    if (await s.execute(select(User.id).where(User.username == name))).first():
        raise HTTPException(409, f"'{name}' 아이디가 이미 있습니다")
    u = User(username=name, name=body.name.strip()[:64], password_hash=auth.hash_password(body.password),
             is_admin=body.role == "admin", can_edit=body.role == "edit")
    s.add(u)
    await s.commit()
    return _user_dict(u)


@router.put("/users/{user_id}")
async def update_user(user_id: int, body: UserPatch, request: Request, s: AsyncSession = Depends(get_session)) -> dict:
    me_ = await auth.current_user(request)
    if not me_.is_admin:
        raise HTTPException(403, "관리자만 할 수 있습니다")
    u = await s.get(User, user_id)
    if not u:
        raise HTTPException(404, "사용자를 찾을 수 없습니다")
    if body.name is not None:
        u.name = body.name.strip()[:64]
    if body.password is not None:
        auth.check_password_rules(None, body.password)
        u.password_hash = auth.hash_password(body.password)
        u.session_ver += 1
    if body.role is not None and body.role != auth.role_of(u):
        _check_role(body.role)
        if u.is_admin and body.role != "admin":
            if await _admin_count(s) <= 1:
                raise HTTPException(409, "관리자가 한 명은 있어야 합니다")
            if u.id == me_.id:
                raise HTTPException(409, "자기 자신의 관리자 권한은 뺄 수 없습니다")
        u.is_admin, u.can_edit = body.role == "admin", body.role == "edit"
    if body.reset_otp:
        # 휴대폰을 잃어버린 사용자: 2단계 인증을 지우고 기존 로그인을 끊는다. 관리자·편집자는 다음 로그인 때 다시 등록한다
        u.totp_secret, u.totp_pending, u.recovery_codes = "", "", ""
        u.session_ver += 1
    await s.commit()
    return _user_dict(u)


@router.delete("/users/{user_id}")
async def delete_user(user_id: int, request: Request, s: AsyncSession = Depends(get_session)) -> dict:
    me_ = await auth.current_user(request)
    if not me_.is_admin:
        raise HTTPException(403, "관리자만 할 수 있습니다")
    u = await s.get(User, user_id)
    if not u:
        raise HTTPException(404, "사용자를 찾을 수 없습니다")
    if u.id == me_.id:
        raise HTTPException(409, "자기 자신은 지울 수 없습니다")
    if u.is_admin and await _admin_count(s) <= 1:
        raise HTTPException(409, "관리자가 한 명은 있어야 합니다")
    await s.delete(u)
    await s.commit()
    return {"ok": True}


# ------------------------------------------------------------------ servers / services
_counts: dict[str, int] = {}
SERVICE_COLS = (Service.id, Service.server_id, Service.name, Service.path, Service.makefile_sha, Service.sync_error)


async def _node_counts(s: AsyncSession, shas: set[str]) -> dict[str, int]:
    """서버 목록은 5초마다 불리므로 Makefile 원문은 처음 보는 sha 일 때만 읽어서 노드 수를 센다."""
    missing = {x for x in shas if x and x not in _counts}
    if missing:
        if len(_counts) > 2000:
            _counts.clear()
        for sha_, text in (await s.execute(select(Service.makefile_sha, Service.makefile)
                                           .where(Service.makefile_sha.in_(missing)).distinct())).all():
            _counts[sha_] = len(services.model_of(text, sha_)["order"]) if text else 0
    return {x: _counts.get(x, 0) for x in shas}


@router.get("/servers")
async def list_servers(user: str = Member, s: AsyncSession = Depends(get_session)) -> list[dict]:
    servers = (await s.execute(select(Server).order_by(Server.environment.desc(), Server.id))).scalars().all()
    rows = (await s.execute(select(*SERVICE_COLS).order_by(Service.name))).all()
    counts = await _node_counts(s, {r.makefile_sha for r in rows})
    by_server: dict[str, list] = {}
    for r in rows:
        by_server.setdefault(r.server_id, []).append(r)
    out = []
    for srv in servers:
        status, disk = hub.status.get(srv.id) or {}, hub.disk.get(srv.id) or {}
        items = [{"id": v.id, "name": v.name, "path": v.path, "node_count": counts.get(v.makefile_sha, 0),
                  "sync_error": v.sync_error, "status": status.get(v.name), "disk": disk.get(v.name)}
                 for v in by_server.get(srv.id, ())]
        out.append({**services.server_brief(srv), "services": items})
    # 웹에서 추가했지만 아직 한 번도 연결되지 않은 서버
    known = {srv.id for srv in servers}
    for key in (await s.execute(select(AgentKey.agent_id).order_by(AgentKey.agent_id))).scalars():
        if key not in known:
            out.append({"id": key, "hostname": "", "environment": "dev", "version": "", "online": False,
                        "metrics": None, "last_seen": None, "beszel_url": services.beszel_link(key),
                        "pending": True, "services": []})
    return out


async def _load(s: AsyncSession, service_id: int) -> tuple[Service, Server]:
    svc = await s.get(Service, service_id)
    if not svc:
        raise HTTPException(404, "서비스를 찾을 수 없습니다")
    srv = await s.get(Server, svc.server_id)
    return svc, srv


@router.get("/services/{service_id}")
async def get_service(service_id: int, user: str = Member, s: AsyncSession = Depends(get_session)) -> dict:
    svc, srv = await _load(s, service_id)
    return services.service_dict(svc, srv)


@router.get("/services/{service_id}/metrics")
async def service_metrics(service_id: int, since: float = 0, user: str = Member, s: AsyncSession = Depends(get_session)) -> dict:
    """서비스 컨테이너들의 CPU·메모리 합계, 최근 1시간. since 를 주면 그 뒤의 점만 준다."""
    row = (await s.execute(select(Service.server_id, Service.name).where(Service.id == service_id))).first()
    if not row:
        raise HTTPException(404, "서비스를 찾을 수 없습니다")
    return {"points": hub.points_since(hub.svc_history.get((row.server_id, row.name), ()), since)}


@router.post("/services/{service_id}/sync")
async def sync(service_id: int, user: str = Member) -> dict:
    try:
        await services.sync_service(service_id)
    except AgentOffline:
        raise HTTPException(409, "에이전트가 오프라인이라 Makefile을 불러올 수 없습니다")
    except LookupError as e:
        raise HTTPException(404, str(e))
    async with SessionLocal() as s:
        svc, srv = await _load(s, service_id)
        return services.service_dict(svc, srv)


@router.get("/templates")
async def list_templates(user: str = Member) -> list[dict]:
    return [{**t, "content": to_makefile(services.model_of(t["content"]))} for t in TEMPLATES]


class InitIn(BaseModel):
    template: str


@router.post("/services/{service_id}/init")
async def init_makefile(service_id: int, body: InitIn, user: str = Editor) -> dict:
    """Makefile 이 없는 서비스에 템플릿으로 새로 만든다. 이미 있으면 덮어쓰지 않는다."""
    tpl = TEMPLATES_BY_ID.get(body.template)
    if not tpl:
        raise HTTPException(422, "없는 템플릿입니다")
    async with SessionLocal() as s:
        svc, srv = await _load(s, service_id)
        if svc.makefile:
            raise HTTPException(409, "이미 Makefile이 있습니다")
        text = to_makefile(services.model_of(tpl["content"]))
        try:
            reply = await hub.request(svc.server_id, {"type": "write_makefile", "project": svc.name,
                                                       "content": text, "expected_sha": services.sha("")})
        except AgentOffline:
            raise HTTPException(409, "에이전트가 오프라인이라 만들 수 없습니다")
        except asyncio.TimeoutError:
            raise HTTPException(504, "에이전트가 응답하지 않습니다")
        if not reply.get("ok"):
            raise HTTPException(409, str(reply.get("error") or "Makefile을 만들지 못했습니다"))
        svc.makefile, svc.makefile_sha, svc.sync_error = text, services.sha(text), ""
        svc.synced_at = services.utcnow()
        await s.commit()
        return services.service_dict(svc, srv)


class ModelIn(BaseModel):
    model: dict[str, Any]
    sha: str


@router.put("/services/{service_id}/model")
async def save_model(service_id: int, body: ModelIn, user: str = Editor) -> dict:
    """노드 편집 결과를 Makefile로 만들어 에이전트에게 쓰게 한다."""
    async with SessionLocal() as s:
        svc, srv = await _load(s, service_id)
        current = services.model_of(svc.makefile, svc.makefile_sha)
        if current["readonly"]:
            raise HTTPException(409, current["readonly"])
        if body.sha != svc.makefile_sha:
            raise HTTPException(409, "다른 곳에서 Makefile이 바뀌었습니다. 다시 불러온 뒤 편집하세요")
        try:
            model = validate_model(body.model)
        except ModelError as e:
            raise HTTPException(422, str(e))
        model["extra"] = current["extra"]  # 해석하지 않은 줄은 서버에 있던 그대로 유지
        text = to_makefile(model)
        try:
            reply = await hub.request(svc.server_id, {"type": "write_makefile", "project": svc.name,
                                                       "content": text, "expected_sha": svc.makefile_sha})
        except AgentOffline:
            raise HTTPException(409, "에이전트가 오프라인이라 저장할 수 없습니다")
        except asyncio.TimeoutError:
            raise HTTPException(504, "에이전트가 응답하지 않습니다")
        if not reply.get("ok"):
            raise HTTPException(409, str(reply.get("error") or "Makefile을 쓰지 못했습니다"))
        svc.makefile, svc.makefile_sha, svc.sync_error = text, services.sha(text), ""
        svc.synced_at = services.utcnow()
        # 이름이 바뀌거나 지워진 노드의 위치·즐겨찾기 정리
        layout = dict(svc.layout or {})
        names = set(model["nodes"])
        layout["positions"] = {k: v for k, v in (layout.get("positions") or {}).items() if k in names}
        layout["favorites"] = [k for k in (layout.get("favorites") or []) if k in names]
        svc.layout = layout
        await s.commit()
        return services.service_dict(svc, srv)


class LayoutIn(BaseModel):
    positions: dict[str, dict[str, float]] = Field(default_factory=dict)
    favorites: list[str] = Field(default_factory=list)


@router.put("/services/{service_id}/layout")
async def save_layout(service_id: int, body: LayoutIn, user: str = Member, s: AsyncSession = Depends(get_session)) -> dict:
    svc, _ = await _load(s, service_id)
    pos = {k: {"x": float(v.get("x", 0)), "y": float(v.get("y", 0))} for k, v in body.positions.items() if NAME_RE.match(k)}
    svc.layout = {"positions": pos, "favorites": [f for f in body.favorites if NAME_RE.match(f)][:50]}
    await s.commit()
    return svc.layout


# ------------------------------------------------------------------ 설정
@router.get("/settings")
async def get_settings(user: str = Admin) -> dict:
    return prefs.describe()


@router.put("/settings")
async def put_settings(body: dict[str, str | None], user: str = Admin) -> dict:
    """{"beszel_url": "https://..."} 처럼 바꿀 값만 보낸다. null 은 .env 값으로 되돌리기."""
    try:
        await prefs.save(body)
    except ValueError as e:
        raise HTTPException(422, str(e))
    return prefs.describe()


# ------------------------------------------------------------------ runs
class RunIn(BaseModel):
    target: str
    vars: dict[str, str] = Field(default_factory=dict)


@router.post("/services/{service_id}/runs")
async def create_run(service_id: int, body: RunIn, user: str = Member) -> dict:
    if not NAME_RE.match(body.target):
        raise HTTPException(422, "명령어 이름이 올바르지 않습니다")
    vars_ = {}
    for k, v in body.vars.items():
        v = v.strip()
        if not v:
            continue
        if not VAR_RE.match(k):
            raise HTTPException(422, f"인자 이름이 올바르지 않습니다: {k}")
        if not VALUE_RE.match(v):
            raise HTTPException(422, f"{k} 값에 쓸 수 없는 문자가 있습니다. 영문, 숫자와 _ . , : / @ + = % - 만 쓸 수 있습니다")
        vars_[k] = v
    try:
        run_id = await runner.start_run(service_id, body.target, vars_, user)
    except AgentOffline:
        raise HTTPException(409, "에이전트가 오프라인입니다")
    except runner.RunError as e:
        raise HTTPException(409, str(e))
    return {"run_id": run_id}


def _run_dict(run: Run, steps: list[RunStep]) -> dict:
    return {
        "id": run.id, "service_id": run.service_id, "target": run.target, "vars": run.vars, "status": run.status,
        "multi": bool(run.multi), "started_at": iso(run.started_at),
        "finished_at": iso(run.finished_at), "duration": run.duration,
        "triggered_by": run.triggered_by, "commit": run.commit,
        "steps": [{"node": x.node, "status": x.status, "exit_code": x.exit_code, "duration": x.duration,
                   "cpu_seconds": x.cpu_seconds, "max_rss_kb": x.max_rss_kb} for x in steps],
    }


@router.get("/services/{service_id}/runs")
async def list_runs(service_id: int, limit: int = 20, user: str = Member, s: AsyncSession = Depends(get_session)) -> list[dict]:
    runs = (await s.execute(select(Run).where(Run.service_id == service_id).order_by(Run.id.desc()).limit(min(limit, 100)))).scalars().all()
    return [_run_dict(r, []) for r in runs]


@router.get("/runs/{run_id}")
async def get_run(run_id: int, user: str = Member, s: AsyncSession = Depends(get_session)) -> dict:
    run = await s.get(Run, run_id)
    if not run:
        raise HTTPException(404, "실행 기록을 찾을 수 없습니다")
    steps = (await s.execute(select(RunStep).where(RunStep.run_id == run_id).order_by(RunStep.id))).scalars().all()
    return _run_dict(run, list(steps))


@router.post("/runs/{run_id}/stop")
async def stop(run_id: int, user: str = Member) -> dict:
    await runner.stop_run(run_id)
    return {"ok": True}


LOG_TAIL = 5000  # web/src/useRunStream.ts 의 MAX_LINES 와 같게


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


@router.get("/runs/{run_id}/events")
async def run_events(run_id: int, request: Request, user: str = Member) -> StreamingResponse:
    """지난 로그를 먼저 보내고, 실행 중이면 이어서 실시간으로 보낸다 (Server-Sent Events)."""

    async def gen():
        q = hub.subscribe(run_id)
        try:
            async with SessionLocal() as s:
                run = await s.get(Run, run_id)
                if not run:
                    yield _sse({"type": "error", "error": "실행 기록을 찾을 수 없습니다"})
                    return
                steps = (await s.execute(select(RunStep).where(RunStep.run_id == run_id).order_by(RunStep.id))).scalars().all()
                # 화면은 최근 LOG_TAIL 줄만 남기므로 그만큼만 읽는다
                logs = (await s.execute(select(RunLog).where(RunLog.run_id == run_id)
                                        .order_by(RunLog.seq.desc()).limit(LOG_TAIL))).scalars().all()[::-1]
                yield _sse({"type": "snapshot", "run": _run_dict(run, list(steps))})
                last = 0
                if logs and logs[0].seq > 1:
                    yield _sse({"type": "log", "seq": logs[0].seq - 1, "ts": logs[0].ts, "node": "", "stream": "note",
                                "line": f"앞의 로그 {logs[0].seq - 1}줄은 생략했습니다 (최근 {LOG_TAIL}줄만 보여줍니다)"})
                chunk: list[str] = []
                for r in logs:
                    last = r.seq
                    chunk.append(_sse({"type": "log", "seq": r.seq, "ts": r.ts, "node": r.node, "stream": r.stream, "line": r.line}))
                    if len(chunk) >= 500:  # 한 줄씩 쓰지 않고 묶어서 보낸다
                        yield "".join(chunk)
                        chunk = []
                if chunk:
                    yield "".join(chunk)
                if run.status in runner.FINISHED:
                    yield _sse({"type": "run", "status": run.status, "duration": run.duration})
                    return
            while True:
                if await request.is_disconnected():
                    return
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
                    continue
                if ev.get("type") == "log" and ev.get("seq", 0) <= last:
                    continue
                yield _sse(ev)
                if ev.get("type") == "run":
                    return
        finally:
            hub.unsubscribe(run_id, q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
