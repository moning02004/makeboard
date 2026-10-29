import json

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import inspect

from app import api
from app.db import SessionLocal, engine, init_db
from app.hub import hub
from app.main import app
from app.models import Run, RunLog, Server, Service
from app.services import sha

pytestmark = pytest.mark.asyncio(loop_scope="module")
AUTH = {"Authorization": "Bearer test-token-test-token"}
MAKEFILE = "build: ## 빌드\n\techo build\n\ntest: ## 테스트\n\techo test\n"


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def client():
    await init_db()
    async with SessionLocal() as s:
        s.add(Server(id="srv-1", hostname="h1"))
        await s.flush()
        s.add(Service(server_id="srv-1", name="app", path="/srv/app", makefile=MAKEFILE, makefile_sha=sha(MAKEFILE), layout={}))
        s.add(Service(server_id="srv-1", name="empty", path="/srv/empty", layout={}))
        await s.commit()
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def test_indexes_created(client):
    async with engine.connect() as conn:
        names = await conn.run_sync(lambda c: {i["name"] for t in ("runs", "run_steps", "run_logs") for i in inspect(c).get_indexes(t)})
    assert {"ix_runs_service_id_id", "ix_run_steps_run_id_node", "ix_run_logs_run_id_seq"} <= names


async def test_servers_counts_nodes_without_makefile_text(client):
    api._counts.clear()
    r = await client.get("/api/servers", headers=AUTH)
    assert r.status_code == 200
    svcs = {v["name"]: v for v in r.json()[0]["services"]}
    assert svcs["app"]["node_count"] == len(api.services.model_of(MAKEFILE)["order"]) > 0
    assert svcs["empty"]["node_count"] == 0
    assert "makefile" not in svcs["app"]
    # 두 번째부터는 캐시에서 센다
    assert sha(MAKEFILE) in api._counts
    assert (await client.get("/api/servers", headers=AUTH)).json() == r.json()


async def test_metrics_since(client):
    hub.history["srv-1"].extend({"t": t, "cpu": 1} for t in (100, 105, 110))
    all_ = (await client.get("/api/servers/srv-1/metrics", headers=AUTH)).json()["points"]
    new = (await client.get("/api/servers/srv-1/metrics?since=105", headers=AUTH)).json()["points"]
    assert [p["t"] for p in all_] == [100, 105, 110]
    assert [p["t"] for p in new] == [110]


async def test_run_events_sends_only_tail(client):
    total = api.LOG_TAIL + 300
    async with SessionLocal() as s:
        svc = (await s.execute(Service.__table__.select().where(Service.name == "app"))).first()
        run = Run(service_id=svc.id, target="build", status="ok", duration=1.0)
        s.add(run)
        await s.flush()
        s.add_all(RunLog(run_id=run.id, seq=i, ts=float(i), line=f"line {i}") for i in range(1, total + 1))
        await s.commit()
        run_id = run.id
    body = (await client.get(f"/api/runs/{run_id}/events", headers=AUTH)).text
    events = [json.loads(x[6:]) for x in body.split("\n\n") if x.startswith("data: ")]
    logs = [e for e in events if e["type"] == "log"]
    assert events[0]["type"] == "snapshot" and events[-1]["type"] == "run"
    assert logs[0]["stream"] == "note" and "300줄" in logs[0]["line"]
    assert len(logs) == api.LOG_TAIL + 1
    assert logs[-1]["seq"] == total


async def test_settings_and_beszel_link(client):
    r = await client.get("/api/servers", headers=AUTH)
    assert r.json()[0]["beszel_url"] is None
    s = (await client.get("/api/settings", headers=AUTH)).json()
    assert s["beszel_url"] == {"value": "", "env": "", "saved": False, "help": s["beszel_url"]["help"]}

    # 저장하면 바로 서버 목록의 링크에 반영된다
    r = await client.put("/api/settings", headers=AUTH, json={"beszel_url": "https://beszel.example.com/system/{name}",
                                                                 "public_url": "http://10.0.0.5:8000/"})
    assert r.status_code == 200 and r.json()["beszel_url"]["saved"]
    assert r.json()["public_url"]["value"] == "http://10.0.0.5:8000"
    r = await client.get("/api/servers", headers=AUTH)
    assert r.json()[0]["beszel_url"] == "https://beszel.example.com/system/srv-1"
    assert (await client.get("/api/agents/config", headers=AUTH)).json()["public_url"] == "http://10.0.0.5:8000"

    # 잘못된 값, 없는 키는 거부
    assert (await client.put("/api/settings", headers=AUTH, json={"beszel_url": "javascript:alert(1)"})).status_code == 422
    assert (await client.put("/api/settings", headers=AUTH, json={"admin_token": "x"})).status_code == 422

    # 빈 값은 끄기, null 은 .env 값으로 되돌리기
    await client.put("/api/settings", headers=AUTH, json={"beszel_url": ""})
    assert (await client.get("/api/servers", headers=AUTH)).json()[0]["beszel_url"] is None
    r = await client.put("/api/settings", headers=AUTH, json={"beszel_url": None, "public_url": None})
    assert not r.json()["beszel_url"]["saved"] and not r.json()["public_url"]["saved"]
