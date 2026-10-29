"""서버·서비스 DB 작업과 Makefile 동기화."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
from collections import OrderedDict
from datetime import datetime, timezone

from urllib.parse import quote

from sqlalchemy import select

from . import prefs
from .db import SessionLocal
from .hub import AgentOffline, hub
from .makefile import parse_makefile
from .models import Server, Service, iso

log = logging.getLogger("makeboard.services")
PROJECT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def sha(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


# Makefile 파싱 결과를 내용(sha)별로 기억한다. 서비스 상세·실행·저장이 같은 Makefile 을 매번 다시 파싱하지 않도록.
# 돌려준 dict 는 여러 요청이 함께 쓰므로 고치지 말고 읽기만 한다.
_models: OrderedDict[str, dict] = OrderedDict()
MODEL_CACHE = 256


def model_of(text: str, text_sha: str = "") -> dict:
    key = text_sha or sha(text)
    model = _models.get(key)
    if model is None:
        model = parse_makefile(text)
        _models[key] = model
        if len(_models) > MODEL_CACHE:
            _models.popitem(last=False)
    else:
        _models.move_to_end(key)
    return model


async def upsert_agent(agent_id: str, hello: dict) -> list[str]:
    """hello 메시지로 서버와 서비스 목록을 갱신하고, 등록된 프로젝트 이름을 돌려준다."""
    projects = []
    for p in hello.get("projects") or []:
        name, path = str(p.get("name", "")), str(p.get("path", ""))
        if PROJECT_RE.match(name):
            projects.append((name, path[:1024]))
    env = str(hello.get("environment") or "dev")[:16]
    async with SessionLocal() as s:
        srv = await s.get(Server, agent_id)
        if not srv:
            srv = Server(id=agent_id)
            s.add(srv)
        srv.hostname = str(hello.get("hostname") or "")[:255]
        srv.environment = env if env in ("prod", "staging", "dev") else "dev"
        srv.version = str(hello.get("version") or "")[:32]
        srv.last_seen = utcnow()
        existing = {x.name: x for x in (await s.execute(select(Service).where(Service.server_id == agent_id))).scalars()}
        for name, path in projects:
            svc = existing.get(name)
            if svc:
                svc.path = path
            else:
                s.add(Service(server_id=agent_id, name=name, path=path, layout={}))
        await s.commit()
    return [n for n, _ in projects]


async def touch_server(agent_id: str) -> None:
    async with SessionLocal() as s:
        srv = await s.get(Server, agent_id)
        if srv:
            srv.last_seen = utcnow()
            await s.commit()


async def sync_service(service_id: int) -> Service:
    """에이전트에게서 Makefile을 다시 읽어 DB에 반영한다."""
    async with SessionLocal() as s:
        svc = await s.get(Service, service_id)
        if not svc:
            raise LookupError("서비스를 찾을 수 없습니다")
        try:
            reply = await hub.request(svc.server_id, {"type": "read_makefile", "project": svc.name})
        except AgentOffline:
            svc.sync_error = "에이전트가 오프라인입니다"
            await s.commit()
            raise
        if reply.get("ok"):
            text = str(reply.get("content") or "")
            svc.makefile, svc.makefile_sha, svc.sync_error = text, sha(text), ""
        else:
            svc.sync_error = str(reply.get("error") or "Makefile을 읽지 못했습니다")
        svc.synced_at = utcnow()
        await s.commit()
        return svc


async def sync_agent(agent_id: str, names: list[str]) -> None:
    """접속한 에이전트의 Makefile 들을 받아온다. 에이전트는 요청을 동시에 처리하므로 몇 개씩 함께 보낸다."""
    async with SessionLocal() as s:
        ids = (await s.execute(select(Service.id).where(Service.server_id == agent_id, Service.name.in_(names)))).scalars().all()
    sem = asyncio.Semaphore(4)

    async def one(sid: int) -> None:
        async with sem:
            try:
                await sync_service(sid)
            except Exception as e:  # noqa: BLE001
                log.warning("sync %s failed: %s", sid, e)

    await asyncio.gather(*(one(sid) for sid in ids))


def service_status(svc: Service) -> dict | None:
    """에이전트가 마지막으로 보낸 컨테이너 상태. compose 파일이 없거나 오프라인이면 None."""
    return (hub.status.get(svc.server_id) or {}).get(svc.name)


def service_dict(svc: Service, srv: Server | None) -> dict:
    model = model_of(svc.makefile, svc.makefile_sha) if svc.makefile else None
    return {
        "id": svc.id, "name": svc.name, "path": svc.path,
        "server": server_brief(srv) if srv else None,
        "status": service_status(svc),
        "makefile": svc.makefile, "sha": svc.makefile_sha,
        "sync_error": svc.sync_error, "synced_at": iso(svc.synced_at),
        "model": model, "layout": svc.layout or {},
    }


def beszel_link(server_id: str) -> str | None:
    url = prefs.get("beszel_url").strip()
    return url.replace("{name}", quote(server_id, safe="")) if url else None


def server_brief(srv: Server) -> dict:
    return {
        "id": srv.id, "hostname": srv.hostname, "environment": srv.environment, "version": srv.version,
        "online": hub.online(srv.id), "metrics": hub.metrics.get(srv.id),
        "last_seen": iso(srv.last_seen), "beszel_url": beszel_link(srv.id),
    }
