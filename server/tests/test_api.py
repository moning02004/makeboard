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


async def _enroll_otp(client) -> tuple[str, list[str]]:
    """지금 로그인한 계정에 2단계 인증을 등록하고 (비밀값, 복구 코드)를 돌려준다."""
    from app.auth import otp_now

    setup = (await client.post("/api/me/otp/setup")).json()
    assert setup["qr"].startswith("data:image/svg+xml") and setup["uri"].startswith("otpauth://totp/Makeboard:")
    assert (await client.post("/api/me/otp/enable", json={"code": "000000" if otp_now(setup["secret"]) != "000000" else "111111"})).status_code == 422
    r = await client.post("/api/me/otp/enable", json={"code": otp_now(setup["secret"])})
    assert r.status_code == 200
    return setup["secret"], r.json()["recovery_codes"]


async def test_users_login_and_roles(client):
    import time

    from app.auth import ensure_admin, otp_now

    await ensure_admin()
    # 처음 관리자: admin / 관리자 토큰. 관리자는 2단계 인증을 등록하기 전에는 아무것도 못 한다
    r = await client.post("/api/login", json={"username": "admin", "password": "test-token-test-token"})
    assert r.json() == {"ok": True}
    me = (await client.get("/api/me")).json()
    assert me["admin"] and me["otp"] == {"enabled": False, "required": True, "setup_required": True}
    assert (await client.get("/api/users")).status_code == 403
    secret, codes = await _enroll_otp(client)
    assert len(codes) == 10
    assert (await client.get("/api/me")).json()["otp"]["setup_required"] is False
    assert (await client.get("/api/users")).status_code == 200

    # 다시 로그인하면 비밀번호 다음에 코드를 묻는다. 방금 쓴 코드는 다시 못 쓰고, 복구 코드는 한 번만 쓸 수 있다
    client.cookies.clear()
    r = (await client.post("/api/login", json={"username": "admin", "password": "test-token-test-token"})).json()
    assert r["otp_required"] and "mb_session" not in client.cookies
    assert (await client.post("/api/login/otp", json={"ticket": r["ticket"], "code": otp_now(secret)})).status_code == 401
    assert (await client.post("/api/login/otp", json={"ticket": "otp.1.1.9.bad", "code": codes[0]})).status_code == 401
    r2 = await client.post("/api/login/otp", json={"ticket": r["ticket"], "code": codes[0]})
    assert r2.status_code == 200 and r2.json()["recovery_left"] == 9
    assert (await client.post("/api/login/otp", json={"ticket": r["ticket"], "code": codes[0]})).status_code == 401
    # 다음 30초 칸의 코드는 쓸 수 있다
    r3 = await client.post("/api/login/otp", json={"ticket": r["ticket"], "code": otp_now(secret, time.time() + 30)})
    assert r3.status_code == 200
    admin_cookie = client.cookies.get("mb_session")
    assert (await client.post("/api/me/otp/disable", json={"code": codes[1]})).status_code == 409  # 관리자는 못 끈다

    # 관리자가 사용자 추가: 실행 권한(kim), 편집 권한(lee)
    assert (await client.post("/api/users", json={"username": "kim", "password": "short"})).status_code == 422
    assert (await client.post("/api/users", json={"username": "x1", "password": "password-1", "role": "boss"})).status_code == 422
    kim = (await client.post("/api/users", json={"username": "kim", "password": "kim-password", "role": "run"})).json()
    lee = (await client.post("/api/users", json={"username": "lee", "password": "lee-password", "role": "edit"})).json()
    assert kim["role"] == "run" and lee["role"] == "edit" and not kim["otp"]
    assert (await client.post("/api/users", json={"username": "kim", "password": "kim-password"})).status_code == 409

    # 실행 권한: 2단계 인증 없이 보고 실행만. 편집·관리는 403
    client.cookies.clear()
    assert (await client.post("/api/login", json={"username": "kim", "password": "wrong-password"})).status_code == 401
    assert (await client.post("/api/login", json={"username": "kim", "password": "kim-password"})).json() == {"ok": True}
    me = (await client.get("/api/me")).json()
    assert not me["edit"] and me["otp"]["required"] is False
    assert (await client.get("/api/servers")).status_code == 200
    svc_id = (await client.get("/api/servers")).json()[0]["services"][0]["id"]
    assert (await client.put(f"/api/services/{svc_id}/model", json={"model": {}, "sha": ""})).status_code == 403
    assert (await client.get("/api/settings")).status_code == 403
    assert (await client.get("/api/users")).status_code == 403
    assert (await client.post("/api/agents", json={"name": "x", "public_url": "http://a:1"})).status_code == 403
    # 자기 비밀번호 변경
    assert (await client.put("/api/me/password", json={"current": "kim-password", "new": "kim-password-2"})).status_code == 200
    kim_cookie = client.cookies.get("mb_session")

    # 편집 권한: 2단계 인증을 등록해야 편집할 수 있다
    client.cookies.clear()
    await client.post("/api/login", json={"username": "lee", "password": "lee-password"})
    assert (await client.get("/api/servers")).status_code == 403
    await _enroll_otp(client)
    assert (await client.get("/api/me")).json()["edit"] is True
    r = await client.put(f"/api/services/{svc_id}/model", json={"model": {}, "sha": "stale"})
    assert r.status_code == 409  # 권한은 통과 (sha 가 달라 저장은 안 됨)

    # 관리자: 비밀번호 재설정은 기존 세션을 끊고, 2단계 인증 초기화도 할 수 있다
    client.cookies.clear()
    client.cookies.set("mb_session", admin_cookie)
    assert (await client.put(f"/api/users/{kim['id']}", json={"password": "reset-password"})).status_code == 200
    assert (await client.put(f"/api/users/{lee['id']}", json={"reset_otp": True})).json()["otp"] is False
    assert (await client.put(f"/api/users/{kim['id']}", json={"role": "edit"})).json()["role"] == "edit"
    me_id = next(u["id"] for u in (await client.get("/api/users")).json() if u["username"] == "admin")
    assert (await client.put(f"/api/users/{me_id}", json={"role": "run"})).status_code == 409
    assert (await client.delete(f"/api/users/{me_id}")).status_code == 409
    client.cookies.clear()
    client.cookies.set("mb_session", kim_cookie)
    assert (await client.get("/api/me")).status_code == 401

    # 지우면 로그인할 수 없다. CLI 관리자 토큰은 2단계 인증 없이 그대로 쓸 수 있다
    client.cookies.clear()
    client.cookies.set("mb_session", admin_cookie)
    assert (await client.delete(f"/api/users/{kim['id']}")).status_code == 200
    client.cookies.clear()
    assert (await client.post("/api/login", json={"username": "kim", "password": "reset-password"})).status_code == 401
    assert (await client.get("/api/users", headers=AUTH)).status_code == 200


async def test_reinstall_and_kubeconfig(client):
    body = {"name": "srv-1", "public_url": "http://10.0.0.5:8000", "scan": ["/srv"]}
    assert (await client.post("/api/agents", headers=AUTH, json=body)).status_code == 409
    r = await client.post("/api/agents", headers=AUTH, json={**body, "replace": True, "kubeconfig": "/home/ubuntu/.kube/config"})
    assert r.status_code == 200
    cmd = r.json()["command"]
    assert "-v /home/ubuntu/.kube/config:/etc/makeboard/kubeconfig:ro" in cmd and "KUBECONFIG=/etc/makeboard/kubeconfig" in cmd
    r = await client.post("/api/agents", headers=AUTH, json={**body, "replace": True, "kubeconfig": "~/.kube/config"})
    assert r.status_code == 422
    # 편집 화면은 저장된 설치 값을 불러온다
    opts = (await client.get("/api/servers/srv-1/install", headers=AUTH)).json()
    assert opts == {"scan": ["/srv"], "kubeconfig": "/home/ubuntu/.kube/config", "run_as": ""}
    # 쿠버네티스를 끄고 저장하면 kubeconfig 도 지워진다
    r = await client.post("/api/agents", headers=AUTH, json={**body, "replace": True, "kubeconfig": ""})
    assert "KUBECONFIG" not in r.json()["command"]
    assert (await client.get("/api/servers/srv-1/install", headers=AUTH)).json()["kubeconfig"] == ""

