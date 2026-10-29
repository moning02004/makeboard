"""쿠버네티스 Secret 값을 키 단위로 보기·수정 (환경변수 .env 와 같은 방식).

- 키 목록: 로그인한 누구나 (값은 보내지 않는다)
- 값 보기·수정·삭제: 편집자·관리자 + 10분 안에 다시 인증 (auth.require_elevated)
- data 는 base64 로 풀어서 보여 주고, 저장할 때 다시 base64 로 감싼다. stringData 는 그대로
- 그 키의 줄만 바꾸고 파일의 다른 내용·주석은 그대로 둔다
- 값이 남지 않도록 파일 변경 기록(FileRevision)에는 저장하지 않고, 감사 기록에 누가 어떤 키를 보고 바꿨는지만 남긴다
"""

from __future__ import annotations

import base64
import binascii
import json
import re

import yaml
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from . import auth, files
from .auth import require_user
from .services import sha
from .topology import _ensure_nl, _lines, doc_ranges, replace_doc

router = APIRouter(prefix="/api/services/{service_id}/secret")
Member = Depends(require_user)
SECTION_RE = re.compile(r"^(\s*)(data|stringData)\s*:\s*(#.*)?$")
KEY_LINE_RE = re.compile(r"^(\s+)(\"[^\"]+\"|'[^']+'|[^\s:#][^:]*?)\s*:(\s.*|)$")
KEY_RE = re.compile(r"^[-._a-zA-Z0-9]{1,253}$")  # 쿠버네티스 Secret 키 규칙


def _doc(text: str, index: int) -> tuple[str, dict]:
    ranges = doc_ranges(text)
    if not 0 <= index < len(ranges):
        raise HTTPException(409, "파일이 바뀌었습니다. 다시 불러오세요")
    s, e = ranges[index]
    body = "".join(_lines(text)[s:e])
    obj = yaml.safe_load(body)
    if not (isinstance(obj, dict) and obj.get("kind") == "Secret"):
        raise HTTPException(409, "Secret 이 아닙니다. 다시 불러오세요")
    return body, obj


def keys_of(obj: dict) -> list[dict]:
    out = []
    for section in ("data", "stringData"):
        for k, v in (obj.get(section) or {}).items():
            out.append({"key": str(k), "section": section, "empty": v in (None, "")})
    return out


def value_of(obj: dict, key: str) -> tuple[str, bool]:
    """(값, 글자로 풀 수 없는 바이너리여서 base64 그대로인지)"""
    if key in (obj.get("stringData") or {}):
        return str(obj["stringData"][key] or ""), False
    if key in (obj.get("data") or {}):
        raw = str(obj["data"][key] or "")
        try:
            return base64.b64decode(raw, validate=True).decode("utf-8"), False
        except (binascii.Error, UnicodeDecodeError):
            return raw, True
    raise HTTPException(404, f"{key} 키가 없습니다")


def set_key(body: str, key: str, value: str | None) -> str:
    """Secret 문서에서 키 하나를 바꾸거나 더하거나(value) 지운다(None). 다른 줄은 그대로 둔다."""
    obj = yaml.safe_load(body) or {}
    lines = _lines(body)
    # 이 키가 있는 섹션, 없으면 새 키를 넣을 섹션(stringData 를 쓰는 Secret 이면 거기, 아니면 data)
    where = "stringData" if key in (obj.get("stringData") or {}) else "data" if key in (obj.get("data") or {}) else None
    target = where or ("stringData" if obj.get("stringData") and not obj.get("data") else "data")
    encoded = None if value is None else (
        base64.b64encode(value.encode()).decode() if target == "data" else json.dumps(value, ensure_ascii=False))

    sec = next((i for i, l in enumerate(lines) if (m := SECTION_RE.match(l.rstrip("\r\n"))) and m[2] == target), None)
    if sec is None:
        if value is None:
            raise HTTPException(404, f"{key} 키가 없습니다")
        return _ensure_nl(body) + f"{target}:\n  {key}: {encoded}\n"
    base = len(lines[sec]) - len(lines[sec].lstrip(" "))
    # 섹션 안의 키 줄들 (블록 값 | > 의 이어지는 줄까지 한 키로 묶는다)
    end, child, found = len(lines), None, None
    i = sec + 1
    while i < len(lines):
        l = lines[i]
        if l.strip() and not l.lstrip().startswith("#"):
            ind = len(l) - len(l.lstrip(" "))
            if ind <= base:
                end = i
                break
            m = KEY_LINE_RE.match(l.rstrip("\r\n"))
            if m and (child is None or ind == child):
                child = ind
                j = i + 1
                while j < len(lines) and (not lines[j].strip() or len(lines[j]) - len(lines[j].lstrip(" ")) > ind):
                    j += 1
                if m[2].strip("'\"") == key:
                    found = (i, j)
                i = j
                continue
        i += 1
    child = child if child is not None else base + 2
    if found:
        s, e = found
        repl = [] if value is None else [" " * child + f"{key}: {encoded}\n"]
        return "".join(lines[:s] + repl + lines[e:])
    if value is None:
        raise HTTPException(404, f"{key} 키가 없습니다")
    at = end
    while at > sec + 1 and not lines[at - 1].strip():
        at -= 1
    if lines and not lines[-1].endswith("\n"):
        lines[-1] += "\n"
    lines[at:at] = [" " * child + f"{key}: {encoded}\n"]
    return "".join(lines)


class Ref(BaseModel):
    path: str
    doc: int


class KeyIn(Ref):
    key: str


class SetIn(KeyIn):
    value: str | None = None  # None 이면 지운다
    sha: str


async def _load(service_id: int, path: str, doc: int):
    svc, _ = await files._service(service_id)
    text = await files._read(svc, path)
    body, obj = _doc(text, doc)
    return svc, text, body, obj


@router.get("")
async def list_keys(service_id: int, path: str, doc: int, user: str = Member) -> dict:
    _, text, _, obj = await _load(service_id, path, doc)
    return {"keys": keys_of(obj), "sha": sha(text)}


@router.post("/reveal")
async def reveal(service_id: int, body: KeyIn, request: Request) -> dict:
    cu = await auth.require_elevated(request)
    svc, _, _, obj = await _load(service_id, body.path, body.doc)
    value, binary = value_of(obj, body.key)
    await auth.audit(request, cu.username, "secret.reveal", f"{svc.server_id}:{svc.name}/{body.path} {_name(obj)}.{body.key}")
    return {"value": value, "binary": binary}


@router.put("")
async def set_secret(service_id: int, body: SetIn, request: Request) -> dict:
    cu = await auth.require_elevated(request)
    if not KEY_RE.match(body.key):
        raise HTTPException(422, "키는 영문, 숫자, - _ . 로 씁니다")
    if body.value is not None and len(body.value) > 65536:
        raise HTTPException(422, "값이 너무 깁니다")
    svc, text, doc_text, obj = await _load(service_id, body.path, body.doc)
    if sha(text) != body.sha:
        raise HTTPException(409, "파일이 그사이 바뀌었습니다. 다시 불러오세요")
    new = replace_doc(text, body.doc, set_key(doc_text, body.key, body.value))
    if files.yaml_error(new):
        raise HTTPException(422, files.yaml_error(new))
    # 변경 기록(파일 버전)에는 남기지 않는다. 값이 DB 에 남지 않도록
    reply = await files._ask(svc, {"type": "write_file", "path": body.path, "content": new, "expected_sha": sha(text)})
    await auth.audit(request, cu.username, "secret.delete" if body.value is None else "secret.set",
                     f"{svc.server_id}:{svc.name}/{body.path} {_name(obj)}.{body.key}")
    return {"sha": reply.get("sha") or sha(new)}


def _name(obj: dict) -> str:
    return str((obj.get("metadata") or {}).get("name", "secret"))
