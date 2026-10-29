"""에이전트 WebSocket 엔드포인트.

에이전트가 먼저 접속해 hello(agent_id, token)로 인증한다. 이후 같은 연결로
서버 → 에이전트: run / cancel / read_makefile / write_makefile
에이전트 → 서버: heartbeat / log / done / (req_id가 붙은 응답)
"""

from __future__ import annotations

import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from . import runner, services
from .enroll import check_agent_token
from .hub import AgentConn, hub

router = APIRouter()
log = logging.getLogger("makeboard.agent_ws")


@router.websocket("/ws/agent")
async def agent_ws(ws: WebSocket) -> None:
    await ws.accept()
    try:
        hello = json.loads(await asyncio.wait_for(ws.receive_text(), timeout=10))
    except Exception:  # noqa: BLE001
        await ws.close(code=4400)
        return
    agent_id = str(hello.get("agent_id") or "")
    if hello.get("type") != "hello" or not await check_agent_token(agent_id, str(hello.get("token") or "")):
        log.warning("agent auth failed: %r", agent_id)
        await ws.send_text(json.dumps({"type": "error", "error": "인증에 실패했습니다. agent_id와 token을 확인하세요."}))
        await ws.close(code=4401)
        return

    names = await services.upsert_agent(agent_id, hello)
    conn = AgentConn(ws, agent_id)
    old = hub.attach(conn)
    if old:
        hub.detach(old)
        try:
            await old.ws.close(code=4409)
        except Exception:  # noqa: BLE001
            pass
    await conn.send({"type": "welcome", "agent_id": agent_id})
    log.info("agent connected: %s (%d projects)", agent_id, len(names))
    asyncio.create_task(services.sync_agent(agent_id, names))

    beats = 0
    try:
        while True:
            msg = json.loads(await ws.receive_text())
            kind = msg.get("type")
            if kind == "heartbeat":
                hub.set_metrics(agent_id, msg.get("metrics") or {})
                beats += 1
                if beats % 6 == 1:  # last_seen 은 30초마다만 저장
                    await services.touch_server(agent_id)
            elif kind == "status":
                projects = msg.get("projects")
                hub.set_status(agent_id, projects if isinstance(projects, dict) else {})
            elif kind == "disk":
                sizes = msg.get("sizes")
                hub.disk[agent_id] = sizes if isinstance(sizes, dict) else {}
            elif kind == "log":
                await runner.on_agent_log(str(msg.get("job_id")), msg.get("lines") or [])
            elif kind == "done":
                job = hub.jobs.get(str(msg.get("job_id")))
                if job and not job.future.done():
                    job.future.set_result(msg)
            elif msg.get("req_id"):
                hub.resolve(conn, msg)
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        log.exception("agent %s connection error", agent_id)
    finally:
        hub.detach(conn)
        await services.touch_server(agent_id)
        log.info("agent disconnected: %s", agent_id)
