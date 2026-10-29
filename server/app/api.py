from __future__ import annotations

import asyncio
import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from . import runner, services
from .auth import COOKIE, check_token, require_admin, session_value
from .config import settings
from .db import SessionLocal, get_session
from .hub import AgentOffline, hub
from .makefile import NAME_RE, VALUE_RE, VAR_RE, ModelError, to_makefile, validate_model
from .templates import BY_ID as TEMPLATES_BY_ID, TEMPLATES
from .models import AgentKey, Run, RunLog, RunStep, Server, Service, iso

router = APIRouter(prefix="/api")
Admin = Depends(require_admin)


# ------------------------------------------------------------------ auth
class LoginIn(BaseModel):
    token: str


@router.post("/login")
async def login(body: LoginIn, response: Response) -> dict:
    if not check_token(body.token):
        raise HTTPException(401, "토큰이 올바르지 않습니다")
    response.set_cookie(COOKIE, session_value(), httponly=True, samesite="strict", secure=settings.cookie_secure,
                        max_age=60 * 60 * 24 * 14)
    return {"ok": True}


@router.post("/logout")
async def logout(response: Response) -> dict:
    response.delete_cookie(COOKIE)
    return {"ok": True}


@router.get("/me")
async def me(user: str = Admin) -> dict:
    return {"user": user}


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
async def list_servers(user: str = Admin, s: AsyncSession = Depends(get_session)) -> list[dict]:
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
                        "metrics": None, "last_seen": None, "pending": True, "services": []})
    return out


async def _load(s: AsyncSession, service_id: int) -> tuple[Service, Server]:
    svc = await s.get(Service, service_id)
    if not svc:
        raise HTTPException(404, "서비스를 찾을 수 없습니다")
    srv = await s.get(Server, svc.server_id)
    return svc, srv


@router.get("/services/{service_id}")
async def get_service(service_id: int, user: str = Admin, s: AsyncSession = Depends(get_session)) -> dict:
    svc, srv = await _load(s, service_id)
    return services.service_dict(svc, srv)


@router.get("/services/{service_id}/metrics")
async def service_metrics(service_id: int, since: float = 0, user: str = Admin, s: AsyncSession = Depends(get_session)) -> dict:
    """서비스 컨테이너들의 CPU·메모리 합계, 최근 1시간. since 를 주면 그 뒤의 점만 준다."""
    row = (await s.execute(select(Service.server_id, Service.name).where(Service.id == service_id))).first()
    if not row:
        raise HTTPException(404, "서비스를 찾을 수 없습니다")
    return {"points": hub.points_since(hub.svc_history.get((row.server_id, row.name), ()), since)}


@router.post("/services/{service_id}/sync")
async def sync(service_id: int, user: str = Admin) -> dict:
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
async def list_templates(user: str = Admin) -> list[dict]:
    return [{**t, "content": to_makefile(services.model_of(t["content"]))} for t in TEMPLATES]


class InitIn(BaseModel):
    template: str


@router.post("/services/{service_id}/init")
async def init_makefile(service_id: int, body: InitIn, user: str = Admin) -> dict:
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
async def save_model(service_id: int, body: ModelIn, user: str = Admin) -> dict:
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
async def save_layout(service_id: int, body: LayoutIn, user: str = Admin, s: AsyncSession = Depends(get_session)) -> dict:
    svc, _ = await _load(s, service_id)
    pos = {k: {"x": float(v.get("x", 0)), "y": float(v.get("y", 0))} for k, v in body.positions.items() if NAME_RE.match(k)}
    svc.layout = {"positions": pos, "favorites": [f for f in body.favorites if NAME_RE.match(f)][:50]}
    await s.commit()
    return svc.layout


# ------------------------------------------------------------------ runs
class RunIn(BaseModel):
    target: str
    vars: dict[str, str] = Field(default_factory=dict)


@router.post("/services/{service_id}/runs")
async def create_run(service_id: int, body: RunIn, user: str = Admin) -> dict:
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
async def list_runs(service_id: int, limit: int = 20, user: str = Admin, s: AsyncSession = Depends(get_session)) -> list[dict]:
    runs = (await s.execute(select(Run).where(Run.service_id == service_id).order_by(Run.id.desc()).limit(min(limit, 100)))).scalars().all()
    return [_run_dict(r, []) for r in runs]


@router.get("/runs/{run_id}")
async def get_run(run_id: int, user: str = Admin, s: AsyncSession = Depends(get_session)) -> dict:
    run = await s.get(Run, run_id)
    if not run:
        raise HTTPException(404, "실행 기록을 찾을 수 없습니다")
    steps = (await s.execute(select(RunStep).where(RunStep.run_id == run_id).order_by(RunStep.id))).scalars().all()
    return _run_dict(run, list(steps))


@router.post("/runs/{run_id}/stop")
async def stop(run_id: int, user: str = Admin) -> dict:
    await runner.stop_run(run_id)
    return {"ok": True}


LOG_TAIL = 5000  # web/src/useRunStream.ts 의 MAX_LINES 와 같게


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


@router.get("/runs/{run_id}/events")
async def run_events(run_id: int, request: Request, user: str = Admin) -> StreamingResponse:
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
