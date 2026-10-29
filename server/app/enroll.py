"""웹에서 서버(에이전트)를 추가하는 기능.

에이전트는 Docker 로만 설치한다.
- POST   /api/agents           이름과 토큰을 발급하고 docker 설치 명령어 한 줄을 돌려준다
- GET    /agent/docker.tar.gz  대상 서버의 `docker build` 가 받아 가는 빌드 컨텍스트
- DELETE /api/servers/{id}     서버를 지운다. 원하면 에이전트 컨테이너도 지우게 한다
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import re
import tarfile
import secrets
import shlex
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, select

from . import prefs
from .auth import require_admin, require_user
from .config import settings
from .db import SessionLocal
from .hub import AgentOffline, hub
from .models import AgentKey, Run, RunLog, RunStep, Server, Service

router = APIRouter()
Admin = Depends(require_admin)
Member = Depends(require_user)

AGENT_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$")
SCAN_RE = re.compile(r"^/[A-Za-z0-9._/-]*$")
USER_RE = re.compile(r"^[a-z_][a-z0-9_.-]{0,31}$")
URL_RE = re.compile(r"^https?://[A-Za-z0-9.\-]+(:\d{1,5})?(/[A-Za-z0-9._/-]*)?$")
DOCKER_CONTEXT = ("Dockerfile", "makeboard_agent.py", "requirements.txt")
CONTAINER = "makeboard-agent"


def token_sha(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def check_agent_token(agent_id: str, token: str) -> bool:
    """.env 의 MAKEBOARD_AGENT_TOKENS 또는 웹에서 발급한 토큰과 맞는지 확인한다."""
    expected = settings.agent_token_map.get(agent_id)
    if expected:
        return secrets.compare_digest(token, expected)
    async with SessionLocal() as s:
        key = await s.get(AgentKey, agent_id)
    return bool(key) and secrets.compare_digest(token_sha(token), key.token_sha)


def agent_dir() -> Path:
    if settings.agent_dir:
        return Path(settings.agent_dir)
    return Path(__file__).resolve().parents[2] / "agent"


# ------------------------------------------------------------------ 대상 서버가 내려받는 파일
@router.get("/agent/docker.tar.gz", include_in_schema=False)
async def docker_context() -> Response:
    """`docker build <이 주소>` 로 대상 서버에서 바로 이미지를 만들 수 있는 빌드 컨텍스트."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for name in DOCKER_CONTEXT:
            f = agent_dir() / name
            if not f.is_file():
                raise HTTPException(500, f"에이전트 파일이 없습니다: {f}")
            tar.add(f, arcname=name)
    return Response(buf.getvalue(), media_type="application/gzip")



# ------------------------------------------------------------------ 웹 API
@router.get("/api/agents/config")
async def agents_config(user: str = Admin) -> dict:
    return {"public_url": prefs.get("public_url").rstrip("/")}


class AgentIn(BaseModel):
    name: str
    environment: str = "prod"
    scan: list[str] = Field(default_factory=lambda: ["/home/ubuntu/services"])
    public_url: str
    # 레시피를 실행할 계정. 비우면 서비스 폴더 소유자, "root" 면 root
    run_as: str = ""
    # 쿠버네티스를 쓰는 서버면 그 호스트의 kubeconfig 경로 (예: /home/ubuntu/.kube/config). 비우면 붙이지 않는다
    kubeconfig: str = ""
    # 이미 있는 서버를 다시 설치(에이전트 업데이트·옵션 변경). 토큰을 새로 만들고 이전 명령어는 무효가 된다
    replace: bool = False


@router.post("/api/agents")
async def create_agent(body: AgentIn, user: str = Admin) -> dict:
    name = body.name.strip()
    if not AGENT_ID_RE.match(name):
        raise HTTPException(422, "이름은 영문, 숫자, - _ . 만 쓸 수 있습니다 (64자 이내)")
    if body.environment not in ("prod", "staging", "dev"):
        raise HTTPException(422, "환경은 prod, staging, dev 중 하나입니다")
    scan = [p.strip().rstrip("/") or "/" for p in body.scan if p.strip()]
    if not scan:
        raise HTTPException(422, "서비스 폴더를 하나 이상 입력하세요")
    for p in scan:
        if not SCAN_RE.match(p):
            raise HTTPException(422, f"폴더는 /로 시작하는 절대 경로로, 영문·숫자·. _ - / 만 쓸 수 있습니다: {p}")
    run_as = body.run_as.strip()
    if run_as and not USER_RE.match(run_as):
        raise HTTPException(422, "실행 계정은 리눅스 사용자 이름 형식으로 입력하세요 (예: deploy)")
    kubeconfig = body.kubeconfig.strip()
    if kubeconfig and (not SCAN_RE.match(kubeconfig) or kubeconfig.endswith("/")):
        raise HTTPException(422, "kubeconfig 는 /로 시작하는 파일 경로로 입력하세요 (예: /home/ubuntu/.kube/config)")
    url = body.public_url.strip().rstrip("/")
    if not URL_RE.match(url):
        raise HTTPException(422, "서버 주소는 http://IP:포트 형식으로 입력하세요")
    if name in settings.agent_token_map:
        raise HTTPException(409, f"'{name}' 은 .env 의 MAKEBOARD_AGENT_TOKENS 에 이미 있습니다")

    token = secrets.token_hex(32)
    async with SessionLocal() as s:
        if await s.get(Server, name) and not body.replace:
            raise HTTPException(409, f"'{name}' 이름의 서버가 이미 있습니다. 업데이트하려면 그 서버의 '다시 설치'를 쓰세요")
        key = await s.get(AgentKey, name)
        if key:
            # 한 번도 연결된 적 없는 이름이면 새 토큰으로 바꿔 준다 (이전 명령어는 무효)
            key.token_sha = token_sha(token)
        else:
            s.add(AgentKey(agent_id=name, token_sha=token_sha(token)))
        await s.commit()

    return {"agent_id": name, "command": docker_command(url, name, token, body.environment, scan, run_as, kubeconfig)}


def ws_url(url: str) -> str:
    return ("wss://" + url[8:] if url.startswith("https://") else "ws://" + url[7:]) + "/ws/agent"


def docker_command(url: str, name: str, token: str, environment: str, scan: list[str], run_as: str = "",
                   kubeconfig: str = "") -> str:
    """호스트에 설치하지 않고 컨테이너로 띄우는 명령어. 다시 실행하면 최신 에이전트로 바뀐다.

    서비스 폴더는 호스트와 같은 경로로 마운트해야 레시피의 docker compose 가 쓰는 상대 경로가
    호스트 Docker 에서도 그대로 맞는다.

    실행 계정: 비우면 첫 서비스 폴더의 소유자, 이름을 주면 그 계정의 UID/GID 로 띄운다.
    root 가 아니면 docker 소켓의 그룹을 더해 주고, 계정 이름이 보이도록 passwd/group 을 읽기 전용으로 붙인다.
    --network host: 네트워크 사용량과 호스트 이름이 컨테이너가 아니라 호스트 기준으로 잡히게 한다.
    kubeconfig: 읽기 전용으로 붙여 레시피의 kubectl 이 호스트의 클러스터(k3s 의 127.0.0.1:6443 등)에 닿게 한다.
    실행 계정이 그 파일을 읽을 수 있어야 한다.
    """
    q = shlex.quote
    if run_as == "root":
        user: list[str] = []
    else:
        uid = f"$(stat -c %u:%g {q(scan[0])})" if not run_as else f"$(id -u {run_as}):$(id -g {run_as})"
        user = [f'--user "{uid}"', '--group-add "$(stat -c %g /var/run/docker.sock)"',
                "-v /etc/passwd:/etc/passwd:ro", "-v /etc/group:/etc/group:ro", "-e HOME=/tmp"]
    run = [
        "docker run -d", f"--name {CONTAINER}", "--restart unless-stopped", "--network host", *user,
        "-v /var/run/docker.sock:/var/run/docker.sock",
        *[f"-v {q(p)}:{q(p)}" for p in scan],
        f"-e MAKEBOARD_SERVER={q(ws_url(url))}", f"-e MAKEBOARD_AGENT_ID={q(name)}",
        f"-e MAKEBOARD_AGENT_TOKEN={q(token)}", f"-e MAKEBOARD_ENVIRONMENT={q(environment)}",
        *([f"-v {q(kubeconfig)}:/etc/makeboard/kubeconfig:ro", "-e KUBECONFIG=/etc/makeboard/kubeconfig",
           "-e KUBECACHEDIR=/tmp/.kube-cache"] if kubeconfig else []),
        f"-e MAKEBOARD_SCAN={q(':'.join(scan))}", f"-e MAKEBOARD_CONTAINER={CONTAINER}", CONTAINER,
    ]
    return (f"docker build -t {CONTAINER} {q(url + '/agent/docker.tar.gz')} && "
            f"{{ docker rm -f {CONTAINER} >/dev/null 2>&1; {' '.join(run)}; }}")


@router.delete("/api/servers/{agent_id}")
async def delete_server(agent_id: str, uninstall: bool = False, user: str = Admin) -> dict:
    """서버를 화면에서 지우고 토큰을 무효로 한다.

    uninstall=true 이고 연결돼 있으면 먼저 에이전트에게 스스로 제거하라고 보낸다. Docker 로 띄운 에이전트는 자기 컨테이너를
    지우고, 그러면 연결이 끊기므로 끊기는지를 보고 성공을 판단한다.
    """
    if agent_id in settings.agent_token_map:
        raise HTTPException(409, f"'{agent_id}' 는 .env 의 MAKEBOARD_AGENT_TOKENS 로 등록된 서버입니다. 거기서 지운 뒤 서버를 재시작하세요")
    async with SessionLocal() as s:
        if not await s.get(Server, agent_id) and not await s.get(AgentKey, agent_id):
            raise HTTPException(404, "서버를 찾을 수 없습니다")
        svc_ids = select(Service.id).where(Service.server_id == agent_id)
        if (await s.execute(select(Run.id).where(Run.service_id.in_(svc_ids), Run.status == "running"))).first():
            raise HTTPException(409, "실행 중인 작업이 있습니다. 끝나거나 중지한 뒤 삭제하세요")

    agent = await _uninstall_agent(agent_id) if uninstall else {"result": "kept", "message": "에이전트는 지우지 않았습니다"}

    async with SessionLocal() as s:
        svc_ids = select(Service.id).where(Service.server_id == agent_id)
        run_ids = select(Run.id).where(Run.service_id.in_(svc_ids))
        # SQLite 는 외래 키 CASCADE 를 기본으로 켜지 않으므로 직접 지운다
        await s.execute(delete(RunLog).where(RunLog.run_id.in_(run_ids)))
        await s.execute(delete(RunStep).where(RunStep.run_id.in_(run_ids)))
        await s.execute(delete(Run).where(Run.service_id.in_(svc_ids)))
        await s.execute(delete(Service).where(Service.server_id == agent_id))
        await s.execute(delete(Server).where(Server.id == agent_id))
        await s.execute(delete(AgentKey).where(AgentKey.agent_id == agent_id))
        await s.commit()
    # 토큰을 지운 뒤 끊어야 다시 접속하지 못한다
    conn = hub.agents.get(agent_id)
    if conn:
        hub.detach(conn)
        try:
            await conn.ws.close(code=4401)
        except Exception:  # noqa: BLE001
            pass
    return {"ok": True, "agent": agent}


async def _uninstall_agent(agent_id: str) -> dict:
    """에이전트에게 제거를 요청하고 결과를 돌려준다. result: removed | manual | unconfirmed | offline (안 지우면 kept)"""
    conn = hub.agents.get(agent_id)
    if not conn:
        return {"result": "offline", "message": "에이전트가 연결돼 있지 않아 자동으로 지우지 못했습니다"}
    try:
        reply = await hub.request(agent_id, {"type": "uninstall"}, timeout=8)
    except (AgentOffline, asyncio.TimeoutError):
        return {"result": "manual", "message": "에이전트가 자동 제거를 지원하지 않는 버전입니다"}
    if not reply.get("ok"):
        return {"result": "manual", "mode": reply.get("mode"), "message": str(reply.get("error") or "에이전트가 제거를 거부했습니다")}
    # 컨테이너가 지워지면 연결이 끊긴다
    for _ in range(40):
        if hub.agents.get(agent_id) is not conn:
            return {"result": "removed", "mode": "docker", "message": f"컨테이너 {reply.get('container')} 를 제거했습니다"}
        await asyncio.sleep(0.2)
    return {"result": "unconfirmed", "mode": "docker", "message": "제거를 요청했지만 연결이 끊기지 않아 확인하지 못했습니다"}


@router.get("/api/servers/{agent_id}/metrics")
async def server_metrics(agent_id: str, since: float = 0, user: str = Member) -> dict:
    """서버 대시보드 차트용 최근 1시간 리소스 기록. since 를 주면 그 뒤의 점만 준다."""
    return {"points": hub.points_since(hub.history.get(agent_id, ()), since)}
