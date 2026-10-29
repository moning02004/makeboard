"""실행 오케스트레이션.

복합 명령어(순차/병렬)와 프리셋은 서버가 직접 펼쳐서, 실제 명령어 노드만 에이전트에게
`make <target> VAR=value` 로 보낸다. 그래서 노드마다 상태·소요 시간·자원 사용량을 따로 기록할 수 있다.
결과는 터미널에서 `make deploy` 를 실행한 것과 같다 (deploy 가 `$(MAKE) a` 를 차례로 부르므로).
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone

from sqlalchemy import select, update

from .config import settings
from .db import SessionLocal
from .hub import AgentOffline, Job, hub
from .makefile import arg_str, collect, help_text
from .models import Run, RunLog, RunStep, Service
from .services import model_of

log = logging.getLogger("makeboard.runner")
FINISHED = {"ok", "failed", "stopped"}


class RunError(Exception):
    pass


class Ctx:
    def __init__(self, run_id: int, agent_id: str, project: str, model: dict, multi: bool):
        self.run_id, self.agent_id, self.project, self.model, self.multi = run_id, agent_id, project, model, multi

    @property
    def cancelled(self) -> bool:
        return self.run_id in hub.cancelled


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


async def start_run(service_id: int, target: str, vars_: dict[str, str], user: str) -> int:
    async with SessionLocal() as s:
        svc = await s.get(Service, service_id)
        if not svc:
            raise RunError("서비스를 찾을 수 없습니다")
        model = model_of(svc.makefile, svc.makefile_sha)
        if target not in model["nodes"]:
            raise RunError(f"{target} 명령어가 Makefile에 없습니다. 다시 불러오세요")
        if not hub.online(svc.server_id):
            raise AgentOffline(svc.server_id)
        plan = collect(model, target)
        run = Run(service_id=svc.id, target=target, vars=vars_, status="running", multi=int(len(plan) > 1),
                  started_at=utcnow(), triggered_by=user, commit=svc.makefile_sha[:12])
        s.add(run)
        await s.flush()
        s.add_all(RunStep(run_id=run.id, node=n, status="queued") for n in plan)
        await s.commit()
        ctx = Ctx(run.id, svc.server_id, svc.name, model, len(plan) > 1)
    asyncio.create_task(_drive(ctx, target, vars_))
    return ctx.run_id


async def stop_run(run_id: int) -> None:
    hub.cancelled.add(run_id)
    for job_id in list(hub.run_jobs.get(run_id, ())):
        job = hub.jobs.get(job_id)
        if job:
            try:
                await hub.send(job.agent_id, {"type": "cancel", "job_id": job_id})
            except AgentOffline:
                if not job.future.done():
                    job.future.set_result({"exit_code": None, "error": "에이전트가 오프라인입니다"})


async def _drive(ctx: Ctx, target: str, vars_: dict[str, str]) -> None:
    t0 = time.monotonic()
    head = f"make {target}{' ' + arg_str(vars_) if vars_ else ''} · {ctx.agent_id}:{ctx.project}"
    await emit(ctx.run_id, [(time.time(), "", "meta", head)])
    try:
        result = await _exec(ctx, target, dict(vars_))
    except Exception:  # noqa: BLE001
        log.exception("run %s crashed", ctx.run_id)
        result = "failed"
    status = "stopped" if ctx.cancelled else result
    duration = round(time.monotonic() - t0, 2)
    async with SessionLocal() as s:
        await s.execute(update(Run).where(Run.id == ctx.run_id).values(status=status, finished_at=utcnow(), duration=duration))
        await s.execute(update(RunStep).where(RunStep.run_id == ctx.run_id, RunStep.status == "queued").values(status="skipped"))
        await s.commit()
    label = {"ok": "완료", "failed": "실패", "stopped": "중지됨"}[status]
    # 중지는 실패가 아니므로 빨간색(err) 대신 회색 안내(note)로 남긴다
    stream = {"ok": "meta", "stopped": "note"}.get(status, "err")
    await emit(ctx.run_id, [(time.time(), "", stream, f"{label} · {duration}s")])
    hub.publish(ctx.run_id, {"type": "run", "status": status, "duration": duration})
    hub.cancelled.discard(ctx.run_id)
    hub.run_jobs.pop(ctx.run_id, None)
    hub.seq.pop(ctx.run_id, None)


async def _exec(ctx: Ctx, name: str, ov: dict[str, str]) -> str:
    if ctx.cancelled:
        return "stopped"
    nd = ctx.model["nodes"][name]
    await set_step(ctx, name, "running")
    kind = nd["kind"]
    if kind == "help" and nd.get("virtual"):
        await emit(ctx.run_id, [(time.time(), name, "out", line) for line in help_text(ctx.model)])
        await set_step(ctx, name, "ok", {"exit_code": 0})
        return "ok"
    if kind in ("cmd", "help"):
        res = await _job(ctx, name, ov)
        code = res.get("exit_code")
        status = "ok" if code == 0 else ("stopped" if ctx.cancelled else "failed")
        if res.get("error"):
            await emit(ctx.run_id, [(time.time(), name, "note" if ctx.cancelled else "err", res["error"])])
        await set_step(ctx, name, status, res)
        return status
    if kind == "preset":
        result = await _exec(ctx, nd["target"], {**ov, **nd["args"]})
    elif nd.get("mode") == "par":
        results = await asyncio.gather(*(_exec(ctx, s, ov) for s in nd["steps"]))
        result = next((r for r in results if r != "ok"), "ok")
    else:
        result = "ok"
        for s in nd["steps"]:
            result = await _exec(ctx, s, ov)
            if result != "ok":
                break
    await set_step(ctx, name, result)
    return result


async def _job(ctx: Ctx, node: str, vars_: dict[str, str]) -> dict:
    job = Job(run_id=ctx.run_id, node=node, agent_id=ctx.agent_id)
    hub.jobs[job.id] = job
    hub.run_jobs[ctx.run_id].add(job.id)
    try:
        if ctx.multi:
            await emit(ctx.run_id, [(time.time(), node, "meta", f"$ make {node}{' ' + arg_str(vars_) if vars_ else ''}")])
        await hub.send(ctx.agent_id, {"type": "run", "job_id": job.id, "project": ctx.project, "target": node,
                                      "vars": vars_, "timeout": settings.job_timeout})
        return await job.future
    except AgentOffline:
        return {"exit_code": None, "error": "에이전트가 오프라인입니다"}
    finally:
        hub.jobs.pop(job.id, None)
        hub.run_jobs[ctx.run_id].discard(job.id)


async def set_step(ctx: Ctx, node: str, status: str, res: dict | None = None) -> None:
    values: dict = {"status": status}
    now = utcnow()
    if status == "running":
        values["started_at"] = now
    else:
        values["finished_at"] = now
    if res:
        for k in ("exit_code", "duration", "cpu_seconds", "max_rss_kb"):
            if res.get(k) is not None:
                values[k] = res[k]
    async with SessionLocal() as s:
        row = (await s.execute(select(RunStep).where(RunStep.run_id == ctx.run_id, RunStep.node == node).limit(1))).scalar_one_or_none()
        if row:
            for k, v in values.items():
                setattr(row, k, v)
            if status != "running" and row.started_at and "duration" not in values:
                started = row.started_at if row.started_at.tzinfo else row.started_at.replace(tzinfo=timezone.utc)
                row.duration = round((now - started).total_seconds(), 2)
            await s.commit()
            values["duration"] = row.duration
    hub.publish(ctx.run_id, {"type": "step", "node": node, "status": status,
                             **{k: values.get(k) for k in ("exit_code", "duration", "cpu_seconds", "max_rss_kb")}})


async def emit(run_id: int, lines: list[tuple[float, str, str, str]]) -> None:
    """로그 줄을 저장한 뒤 구독자에게 보낸다. (ts, node, stream, text)"""
    if not lines:
        return
    rows = []
    for ts, node, stream, text in lines:
        rows.append(RunLog(run_id=run_id, seq=hub.next_seq(run_id), ts=ts, node=node, stream=stream, line=text[:4000]))
    async with SessionLocal() as s:
        s.add_all(rows)
        await s.commit()
    for r in rows:
        hub.publish(run_id, {"type": "log", "seq": r.seq, "ts": r.ts, "node": r.node, "stream": r.stream, "line": r.line})


async def on_agent_log(job_id: str, lines: list) -> None:
    job = hub.jobs.get(job_id)
    if not job:
        return
    out = []
    for item in lines:
        try:
            ts, stream, text = float(item[0]), str(item[1]), str(item[2])
        except (TypeError, ValueError, IndexError):
            continue
        # 노드 이름은 항상 저장하고, 화면에서 여러 노드가 도는 실행일 때만 보여준다
        out.append((ts, job.node, "err" if stream == "err" else "out", text))
    await emit(job.run_id, out)


async def mark_interrupted_runs() -> None:
    """서버 재시작으로 중단된 실행을 실패로 표시한다."""
    async with SessionLocal() as s:
        await s.execute(update(Run).where(Run.status == "running").values(status="failed", finished_at=utcnow()))
        await s.execute(update(RunStep).where(RunStep.status.in_(["queued", "running"])).values(status="skipped"))
        await s.commit()
