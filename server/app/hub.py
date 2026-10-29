"""연결된 에이전트와 진행 중인 실행을 메모리에서 관리한다.

uvicorn 워커 1개를 전제로 한다. 워커를 여러 개 쓰려면 이 부분을 Redis pub/sub 로 바꿔야 한다.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket

log = logging.getLogger("makeboard.hub")
HISTORY_POINTS = 720  # 5초 간격이면 1시간


class AgentOffline(Exception):
    pass


class AgentConn:
    def __init__(self, ws: WebSocket, agent_id: str):
        self.ws = ws
        self.agent_id = agent_id
        self.lock = asyncio.Lock()
        self.pending: dict[str, asyncio.Future] = {}

    async def send(self, msg: dict[str, Any]) -> None:
        async with self.lock:
            await self.ws.send_text(json.dumps(msg, ensure_ascii=False))


@dataclass
class Job:
    run_id: int
    node: str
    agent_id: str
    id: str = field(default_factory=lambda: uuid.uuid4().hex)
    future: asyncio.Future = field(default_factory=lambda: asyncio.get_running_loop().create_future())


class Hub:
    def __init__(self) -> None:
        self.agents: dict[str, AgentConn] = {}
        self.metrics: dict[str, dict[str, Any]] = {}
        # 에이전트가 보낸 서비스(프로젝트)별 컨테이너 상태
        self.status: dict[str, dict[str, Any]] = {}
        # 서버별 최근 리소스 기록 (메모리에만 보관, 서버를 재시작하면 비워진다)
        self.history: dict[str, deque] = defaultdict(lambda: deque(maxlen=HISTORY_POINTS))
        # (서버, 서비스)별 컨테이너 사용량 기록. 15초 간격이면 1시간
        self.svc_history: dict[tuple[str, str], deque] = defaultdict(lambda: deque(maxlen=240))
        # 서버별 서비스 폴더 크기(바이트). 에이전트가 5분마다 보낸다
        self.disk: dict[str, dict[str, int]] = {}
        self.jobs: dict[str, Job] = {}
        self.run_jobs: dict[int, set[str]] = defaultdict(set)
        self.cancelled: set[int] = set()
        self.subs: dict[int, set[asyncio.Queue]] = defaultdict(set)
        self.seq: dict[int, int] = defaultdict(int)

    # ---- agents
    def online(self, agent_id: str) -> bool:
        return agent_id in self.agents

    async def send(self, agent_id: str, msg: dict[str, Any]) -> None:
        conn = self.agents.get(agent_id)
        if not conn:
            raise AgentOffline(agent_id)
        await conn.send(msg)

    async def request(self, agent_id: str, msg: dict[str, Any], timeout: float = 20.0) -> dict[str, Any]:
        conn = self.agents.get(agent_id)
        if not conn:
            raise AgentOffline(agent_id)
        req_id = uuid.uuid4().hex
        fut = asyncio.get_running_loop().create_future()
        conn.pending[req_id] = fut
        try:
            await conn.send({**msg, "req_id": req_id})
            return await asyncio.wait_for(fut, timeout)
        finally:
            conn.pending.pop(req_id, None)

    def resolve(self, conn: AgentConn, msg: dict[str, Any]) -> None:
        fut = conn.pending.get(msg.get("req_id", ""))
        if fut and not fut.done():
            fut.set_result(msg)

    def attach(self, conn: AgentConn) -> AgentConn | None:
        old = self.agents.get(conn.agent_id)
        self.agents[conn.agent_id] = conn
        return old

    def detach(self, conn: AgentConn) -> None:
        if self.agents.get(conn.agent_id) is conn:
            del self.agents[conn.agent_id]
            self.metrics.pop(conn.agent_id, None)
            self.status.pop(conn.agent_id, None)
            self.disk.pop(conn.agent_id, None)
        for fut in conn.pending.values():
            if not fut.done():
                fut.set_exception(AgentOffline(conn.agent_id))
        for job in list(self.jobs.values()):
            if job.agent_id == conn.agent_id and not job.future.done():
                job.future.set_result({"exit_code": None, "error": "에이전트 연결이 끊어졌습니다"})

    def set_metrics(self, agent_id: str, metrics: dict[str, Any]) -> None:
        now = time.time()
        self.metrics[agent_id] = {**metrics, "at": now}
        self.history[agent_id].append({"t": round(now), "cpu": metrics.get("cpu"), "ram": metrics.get("ram"),
                                       "disk": metrics.get("disk"), "rx": metrics.get("rx"), "tx": metrics.get("tx")})

    def set_status(self, agent_id: str, projects: dict[str, Any]) -> None:
        self.status[agent_id] = projects
        now = round(time.time())
        for name, st in projects.items():
            usage = st.get("usage") if isinstance(st, dict) else None
            if usage:
                self.svc_history[(agent_id, name)].append({"t": now, "cpu": usage.get("cpu"), "mem": usage.get("mem")})

    # ---- run events
    def next_seq(self, run_id: int) -> int:
        self.seq[run_id] += 1
        return self.seq[run_id]

    def publish(self, run_id: int, event: dict[str, Any]) -> None:
        for q in list(self.subs.get(run_id, ())):
            q.put_nowait(event)

    def subscribe(self, run_id: int) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self.subs[run_id].add(q)
        return q

    def unsubscribe(self, run_id: int, q: asyncio.Queue) -> None:
        self.subs[run_id].discard(q)
        if not self.subs[run_id]:
            self.subs.pop(run_id, None)


hub = Hub()
