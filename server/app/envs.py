"""서비스 폴더의 환경변수 파일(.env, .env.*, *.env).

- 키 목록: 로그인한 누구나 (값은 보내지 않는다)
- 값 보기·바꾸기·지우기: 편집자·관리자 + 10분 안에 다시 인증 (auth.require_elevated). 키 하나씩만 다룬다.
- 값은 서버 DB·변경 기록·감사 기록 어디에도 남기지 않는다. 감사 기록에는 누가 어떤 키를 봤고 바꿨는지만 남는다.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from . import auth, files
from .auth import require_user

router = APIRouter(prefix="/api/services/{service_id}/env")
Member = Depends(require_user)
MIN_AGENT = (0, 5, 0)


@router.get("")
async def list_env(service_id: int, request: Request, user: str = Member) -> dict:
    svc, _ = await files._service(service_id, MIN_AGENT)
    cu = await auth.current_user(request)
    reply = await files._ask(svc, {"type": "env_list"})
    return {"files": reply.get("files") or [], "can_edit": cu.editor, "elevated_until": auth.elevated_until(request, cu)}


class KeyIn(BaseModel):
    path: str
    key: str


class SetIn(KeyIn):
    value: str | None = None  # None 이면 지운다
    sha: str = ""


@router.post("/reveal")
async def reveal(service_id: int, body: KeyIn, request: Request) -> dict:
    cu = await auth.require_elevated(request)
    svc, _ = await files._service(service_id, MIN_AGENT)
    reply = await files._ask(svc, {"type": "env_get", "path": body.path, "key": body.key})
    await auth.audit(request, cu.username, "env.reveal", f"{svc.server_id}:{svc.name}/{body.path} {body.key}")
    return {"value": reply.get("value", "")}


@router.put("")
async def set_env(service_id: int, body: SetIn, request: Request) -> dict:
    cu = await auth.require_elevated(request)
    svc, _ = await files._service(service_id, MIN_AGENT)
    if body.value is not None and len(body.value) > 8192:
        raise HTTPException(422, "값이 너무 깁니다")
    reply = await files._ask(svc, {"type": "env_set", "path": body.path, "key": body.key, "value": body.value,
                                   "expected_sha": body.sha})
    await auth.audit(request, cu.username, "env.delete" if body.value is None else "env.set",
                     f"{svc.server_id}:{svc.name}/{body.path} {body.key}")
    return {"sha": reply.get("sha", "")}
