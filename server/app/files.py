"""서비스 폴더의 설정 파일(yaml) 보기·고치기·버전 기록.

파일은 에이전트가 읽고 쓴다 (서비스 폴더와 바로 아래 하위 폴더의 *.yaml, *.yml 만).
- 보기: 로그인한 누구나. 쿠버네티스 Secret 이 든 파일은 값을 가리고 읽기 전용으로 보여 준다.
- 고치기·되돌리기: 편집자와 관리자. 저장 전에 yaml 문법을 확인하고, 그사이 서버에서 바뀌었으면 덮어쓰지 않는다.
- 기록: 웹에서 처음 고칠 때 원래 내용을, 그 뒤로는 저장할 때마다 내용을 남긴다.
"""

from __future__ import annotations

import asyncio
import re

import yaml
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select

from .auth import require_editor, require_user
from .db import SessionLocal
from .hub import AgentOffline, hub
from .models import FileRevision, Server, Service, iso
from .services import sha

router = APIRouter(prefix="/api/services/{service_id}/files")
Member = Depends(require_user)
Editor = Depends(require_editor)
MIN_AGENT = (0, 4, 0)
MASK = "••••••"
SECRET_RE = re.compile(r"^kind:\s*['\"]?Secret['\"]?\s*$", re.M)
DOC_SPLIT_RE = re.compile(r"^---.*$", re.M)
KEEP_REVISIONS = 50  # 파일마다 최근 버전만 남긴다


def _version(v: str) -> tuple[int, ...]:
    try:
        return tuple(int(x) for x in v.split(".")[:3])
    except ValueError:
        return (0,)


def has_secret(text: str) -> bool:
    return bool(SECRET_RE.search(text))


def mask_secrets(text: str) -> str:
    """Secret 문서의 data / stringData 아래 값을 가린다. 키 이름은 보여 준다."""
    out, block = [], None  # block: data/stringData 줄의 들여쓰기
    secret_docs = [has_secret(d) for d in DOC_SPLIT_RE.split(text)]
    doc = 0
    for line in text.splitlines(keepends=True):
        if DOC_SPLIT_RE.match(line):
            doc, block = doc + 1, None
            out.append(line)
            continue
        indent = len(line) - len(line.lstrip(" "))
        stripped = line.strip()
        if block is not None and stripped and indent <= block:
            block = None
        if not secret_docs[doc] if doc < len(secret_docs) else True:
            out.append(line)
            continue
        if block is None and re.match(r"^\s*(data|stringData)\s*:\s*$", line):
            block = indent
            out.append(line)
        elif block is not None and stripped:
            nl = "\n" if line.endswith("\n") else ""
            key = re.match(r"^(\s*[^:#]+:)\s*\S", line)
            out.append(f"{key[1]} {MASK}{nl}" if key else f"{' ' * indent}{MASK}{nl}")
        else:
            out.append(line)
    return "".join(out)


def yaml_error(text: str) -> str | None:
    try:
        for _ in yaml.safe_load_all(text):
            pass
    except yaml.YAMLError as e:
        mark = getattr(e, "problem_mark", None)
        where = f"{mark.line + 1}번째 줄: " if mark else ""
        return f"yaml 문법 오류 · {where}{getattr(e, 'problem', None) or e}"
    return None


async def _service(service_id: int) -> tuple[Service, Server]:
    async with SessionLocal() as s:
        svc = await s.get(Service, service_id)
        if not svc:
            raise HTTPException(404, "서비스를 찾을 수 없습니다")
        srv = await s.get(Server, svc.server_id)
    if not hub.online(svc.server_id):
        raise HTTPException(409, "에이전트가 오프라인이라 파일을 볼 수 없습니다")
    if _version(srv.version if srv else "") < MIN_AGENT:
        raise HTTPException(409, f"에이전트를 0.4.0 이상으로 업데이트해야 파일을 볼 수 있습니다 (지금 {srv.version if srv else '-'}). "
                                 "서버 목록의 '편집'에서 저장하고 나온 명령어를 그 서버에서 실행하세요")
    return svc, srv


async def _ask(svc: Service, msg: dict) -> dict:
    try:
        reply = await hub.request(svc.server_id, {**msg, "project": svc.name})
    except AgentOffline:
        raise HTTPException(409, "에이전트가 오프라인입니다")
    except asyncio.TimeoutError:
        raise HTTPException(504, "에이전트가 응답하지 않습니다")
    if not reply.get("ok"):
        raise HTTPException(409, str(reply.get("error") or "에이전트가 요청을 처리하지 못했습니다"))
    return reply


async def _read(svc: Service, path: str) -> str:
    return str((await _ask(svc, {"type": "read_file", "path": path})).get("content") or "")


@router.get("")
async def list_files(service_id: int, user: str = Member) -> list[dict]:
    svc, _ = await _service(service_id)
    return (await _ask(svc, {"type": "list_files"})).get("files") or []


@router.get("/content")
async def read_file(service_id: int, path: str, user: str = Member) -> dict:
    svc, _ = await _service(service_id)
    text = await _read(svc, path)
    secret = has_secret(text)
    return {"path": path, "content": mask_secrets(text) if secret else text, "sha": sha(text),
            "readonly": "쿠버네티스 Secret 이 들어 있어 값을 가리고 보기만 합니다" if secret else None}


class SaveIn(BaseModel):
    path: str
    content: str
    sha: str


async def _write(svc: Service, path: str, old: str, content: str, user: str, note: str) -> str:
    """에이전트에게 쓰게 하고 기록을 남긴다. 처음 고치는 파일이면 원래 내용도 남긴다."""
    reply = await _ask(svc, {"type": "write_file", "path": path, "content": content, "expected_sha": sha(old)})
    async with SessionLocal() as s:
        q = select(FileRevision.id).where(FileRevision.service_id == svc.id, FileRevision.path == path)
        if not (await s.execute(q.limit(1))).first():
            s.add(FileRevision(service_id=svc.id, path=path, content=old, sha=sha(old), author="", note="원래 내용"))
        s.add(FileRevision(service_id=svc.id, path=path, content=content, sha=sha(content), author=user, note=note))
        await s.flush()
        old_ids = (await s.execute(q.order_by(FileRevision.id.desc()).offset(KEEP_REVISIONS))).scalars().all()
        for rid in old_ids:
            await s.delete(await s.get(FileRevision, rid))
        await s.commit()
    return str(reply.get("sha") or sha(content))


def _check_editable(current: str, content: str) -> None:
    if has_secret(current) or has_secret(content):
        raise HTTPException(409, "쿠버네티스 Secret 이 든 파일은 웹에서 고칠 수 없습니다. 서버에서 직접 고치세요")
    # 원래부터 yaml 로 읽히지 않는 파일(Helm 템플릿 등)은 문법 검사를 하지 않는다
    if yaml_error(current) is None:
        err = yaml_error(content)
        if err:
            raise HTTPException(422, err)


@router.put("/content")
async def save_file(service_id: int, body: SaveIn, user: str = Editor) -> dict:
    svc, _ = await _service(service_id)
    current = await _read(svc, body.path)
    if sha(current) != body.sha:
        raise HTTPException(409, "서버의 파일이 그사이 바뀌었습니다. 다시 불러온 뒤 고치세요")
    if body.content == current:
        return {"path": body.path, "sha": body.sha, "changed": False}
    _check_editable(current, body.content)
    new_sha = await _write(svc, body.path, current, body.content, user, "저장")
    return {"path": body.path, "sha": new_sha, "changed": True}


@router.get("/history")
async def history(service_id: int, path: str, user: str = Member) -> list[dict]:
    async with SessionLocal() as s:
        rows = (await s.execute(select(FileRevision).where(FileRevision.service_id == service_id, FileRevision.path == path)
                                .order_by(FileRevision.id.desc()))).scalars().all()
    return [{"id": r.id, "sha": r.sha, "author": r.author, "note": r.note, "size": len(r.content.encode()),
             "created_at": iso(r.created_at)} for r in rows]


@router.get("/history/{rev_id}")
async def revision(service_id: int, rev_id: int, user: str = Member) -> dict:
    async with SessionLocal() as s:
        r = await s.get(FileRevision, rev_id)
    if not r or r.service_id != service_id:
        raise HTTPException(404, "기록을 찾을 수 없습니다")
    return {"id": r.id, "path": r.path, "content": r.content, "sha": r.sha, "author": r.author, "note": r.note,
            "created_at": iso(r.created_at)}


class RevertIn(BaseModel):
    rev_id: int
    sha: str


@router.post("/revert")
async def revert(service_id: int, body: RevertIn, user: str = Editor) -> dict:
    async with SessionLocal() as s:
        r = await s.get(FileRevision, body.rev_id)
    if not r or r.service_id != service_id:
        raise HTTPException(404, "기록을 찾을 수 없습니다")
    svc, _ = await _service(service_id)
    current = await _read(svc, r.path)
    if sha(current) != body.sha:
        raise HTTPException(409, "서버의 파일이 그사이 바뀌었습니다. 다시 불러온 뒤 되돌리세요")
    if r.content == current:
        return {"path": r.path, "sha": body.sha, "changed": False}
    _check_editable(current, r.content)
    new_sha = await _write(svc, r.path, current, r.content, user, f"{r.id}번으로 되돌림")
    return {"path": r.path, "sha": new_sha, "changed": True}
