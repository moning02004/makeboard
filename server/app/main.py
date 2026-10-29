import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import agent_ws, api, auth, enroll, envs, files, prefs, runner, topology
from .config import settings
from .db import init_db

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("makeboard")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    await runner.mark_interrupted_runs()
    await prefs.load()
    await auth.ensure_admin()
    if not settings.otp_required:
        log.warning("MAKEBOARD_OTP_REQUIRED=false: 관리자·편집자에게 2단계 인증을 강제하지 않습니다. 운영에서는 쓰지 마세요.")
    if len(settings.admin_token) < 16:
        log.warning("MAKEBOARD_ADMIN_TOKEN 이 너무 짧습니다. `openssl rand -hex 32` 로 만든 값을 쓰세요.")
    yield


app = FastAPI(title="Makeboard", lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json")
app.include_router(api.router)
app.include_router(agent_ws.router)
app.include_router(enroll.router)
app.include_router(files.router)
app.include_router(topology.router)
app.include_router(envs.router)


@app.get("/healthz")
async def healthz() -> dict:
    return {"ok": True}


# 빌드된 웹 화면 제공 (docker 이미지에서는 /app/web)
dist = Path(settings.web_dist) if settings.web_dist else None
if dist and (dist / "index.html").exists():
    app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str):
        if path.startswith(("api/", "ws/", "agent/")):
            raise HTTPException(404)
        f = dist / path
        if path and f.is_file() and dist in f.resolve().parents:
            return FileResponse(f)
        return FileResponse(dist / "index.html")
