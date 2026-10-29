"""구성도의 '노드 추가': 자주 쓰는 서비스(Redis, RabbitMQ, DB 등)를 compose 나 쿠버네티스 yaml 에 넣는다.

- compose: services 에 서비스 블록, 이름 있는 볼륨을 덧붙인다. 비밀번호는 ${NAME_PASSWORD} 로 참조만 쓰고
  값은 서비스 폴더의 .env 에 넣는다 (비밀값을 쓰므로 다시 인증이 필요하다). 고른 서비스에 depends_on 을 더한다.
- 쿠버네티스: Secret + Service + StatefulSet(데이터가 있는 것) 또는 Deployment 를 새 yaml 파일로 만든다.
기존 파일의 다른 내용과 주석은 그대로 둔다.
"""

from __future__ import annotations

import re
import secrets
from typing import Any

import yaml
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from . import auth, files
from .auth import require_editor, require_user
from .topology import _blank_or_comment, _build_path, _indent, _lines, _reindent, block_body, compose_blocks, replace_block

router = APIRouter(prefix="/api")
Member = Depends(require_user)
Editor = Depends(require_editor)
NAME_RE = re.compile(r"^[a-z0-9]([-a-z0-9]{0,38}[a-z0-9])?$")
IMAGE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,200}$")

# password: 비밀번호를 쓰는 서비스면 그 값을 넣을 환경변수 이름들 (USER 가 필요한 것은 user 로 app 을 쓴다)
CATALOG: list[dict[str, Any]] = [
    {"id": "redis", "name": "Redis", "description": "캐시·세션·큐", "image": "redis:7", "port": 6379, "data": "/data",
     "password": True, "command": ["redis-server", "--requirepass", "{password}"], "env": {}},
    {"id": "rabbitmq", "name": "RabbitMQ", "description": "메시지 큐 (관리 화면 15672)", "image": "rabbitmq:3-management",
     "port": 5672, "ports": [5672, 15672], "data": "/var/lib/rabbitmq", "password": True,
     "env": {"RABBITMQ_DEFAULT_USER": "app", "RABBITMQ_DEFAULT_PASS": "{password}"}},
    {"id": "postgres", "name": "PostgreSQL", "description": "관계형 DB", "image": "postgres:16", "port": 5432,
     "data": "/var/lib/postgresql/data", "password": True,
     "env": {"POSTGRES_USER": "app", "POSTGRES_PASSWORD": "{password}", "POSTGRES_DB": "app"}},
    {"id": "mysql", "name": "MySQL", "description": "관계형 DB", "image": "mysql:8.4", "port": 3306, "data": "/var/lib/mysql",
     "password": True, "env": {"MYSQL_ROOT_PASSWORD": "{password}", "MYSQL_DATABASE": "app"}},
    {"id": "mongodb", "name": "MongoDB", "description": "문서 DB", "image": "mongo:7", "port": 27017, "data": "/data/db",
     "password": True, "env": {"MONGO_INITDB_ROOT_USERNAME": "app", "MONGO_INITDB_ROOT_PASSWORD": "{password}"}},
    {"id": "nginx", "name": "Nginx", "description": "웹 서버·리버스 프록시", "image": "nginx:1.27", "port": 80, "password": False, "env": {}},
    {"id": "custom", "name": "직접 입력", "description": "이미지와 포트를 직접 정합니다", "image": "", "port": None, "password": False, "env": {}},
]
BY_ID = {c["id"]: c for c in CATALOG}


class _Dumper(yaml.SafeDumper):
    """목록을 키 아래로 들여 쓴다 (compose·쿠버네티스 파일에서 흔한 모양)."""

    def increase_indent(self, flow: bool = False, indentless: bool = False):  # noqa: ARG002
        return super().increase_indent(flow, False)


def _dump(data: Any) -> str:
    return yaml.dump(data, Dumper=_Dumper, sort_keys=False, allow_unicode=True, default_flow_style=False)


# '직접 입력'을 Dockerfile 로 빌드할 때, 폴더에 Dockerfile 이 없으면 만들어 줄 기본 내용
DOCKERFILES: dict[str, dict[str, str]] = {
    "python": {"name": "Python", "port": "8000", "content": """FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8000
CMD ["python", "main.py"]
"""},
    "node": {"name": "Node.js", "port": "3000", "content": """FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "index.js"]
"""},
    "static": {"name": "정적 웹 (nginx)", "port": "80", "content": """FROM nginx:1.27-alpine
COPY . /usr/share/nginx/html
EXPOSE 80
"""},
}


@router.get("/catalog")
async def catalog(user: str = Member) -> dict:
    return {"items": [{k: c[k] for k in ("id", "name", "description", "image", "port", "password")} for c in CATALOG],
            "dockerfiles": [{"id": k, "name": v["name"], "port": int(v["port"])} for k, v in DOCKERFILES.items()]}


# ------------------------------------------------------------------ compose
def _env_name(name: str) -> str:
    return re.sub(r"[^A-Z0-9]", "_", name.upper()) + "_PASSWORD"


def compose_body(item: dict, name: str, image: str, port: int | None, has_password: bool, build: str = "") -> tuple[str, str | None]:
    """서비스 블록 내용(이름 줄 제외)과 볼륨 이름. build 를 주면 그 폴더의 Dockerfile 로 빌드한다 (image 는 붙일 태그)."""
    ref = f"${{{_env_name(name)}}}"
    body: dict[str, Any] = {"build": build} if build else {}
    if image:
        body["image"] = image
    body["restart"] = "unless-stopped"
    if item.get("command") and has_password:
        body["command"] = [c.replace("{password}", ref) for c in item["command"]]
    env = {k: v.replace("{password}", ref) for k, v in item.get("env", {}).items() if has_password or "{password}" not in v}
    if env:
        body["environment"] = env
    ports = item.get("ports") or ([port] if port else [])
    if ports:
        body["ports"] = [f"{p}:{p}" for p in ports]
    volume = f"{name}-data" if item.get("data") else None
    if volume:
        body["volumes"] = [f"{volume}:{item['data']}"]
    return _dump(body), volume


def add_compose_service(text: str, name: str, body: str, volume: str | None) -> str:
    if not text.strip():
        text = "services:\n"
    blocks, child = compose_blocks(text)
    if name in blocks:
        raise HTTPException(409, f"'{name}' 서비스가 이미 있습니다")
    lines = _lines(text)
    top = next((i for i, l in enumerate(lines) if re.match(r"^services\s*:\s*(#.*)?$", l.rstrip("\r\n"))), None)
    if top is None:
        raise HTTPException(422, "compose 파일에서 services: 를 찾지 못했습니다")
    child = child or 2
    at = max((e for _, e in blocks.values()), default=top + 1)
    if lines and not lines[-1].endswith("\n"):
        lines[-1] += "\n"
    block = ["\n"] if blocks else []
    block += [" " * child + f"{name}:\n", _reindent(body, child * 2)]
    lines[at:at] = block
    out = "".join(lines)
    if volume:
        out = _add_top_level_key(out, "volumes", volume, child)
    return out


def _add_top_level_key(text: str, section: str, key: str, child: int) -> str:
    """최상위 volumes: 아래에 key: 를 더한다. 없으면 파일 끝에 만든다."""
    lines = _lines(text)
    top = next((i for i, l in enumerate(lines) if re.match(rf"^{section}\s*:\s*(#.*)?$", l.rstrip("\r\n"))), None)
    if top is None:
        return text.rstrip("\n") + f"\n\n{section}:\n{' ' * child}{key}:\n"
    end = len(lines)
    for i in range(top + 1, len(lines)):
        if not _blank_or_comment(lines[i]) and _indent(lines[i]) == 0:
            end = i
            break
    while end > top + 1 and not lines[end - 1].strip():
        end -= 1
    lines[end:end] = [" " * child + f"{key}:\n"]
    return "".join(lines)


def add_depends_on(text: str, service: str, dep: str) -> str:
    """기존 서비스에 depends_on 을 더한다 (블록 목록이든 [a, b] 이든)."""
    found = block_body(text, service)
    if not found:
        return text
    body = found[0]
    data = yaml.safe_load(body) or {}
    deps = data.get("depends_on")
    if (isinstance(deps, list) and dep in deps) or (isinstance(deps, dict) and dep in deps):
        return text
    blines = _lines(body)
    idx = next((i for i, l in enumerate(blines) if re.match(r"^depends_on\s*:", l)), None)
    if idx is None:
        body = body.rstrip("\n") + f"\ndepends_on:\n  - {dep}\n"
    elif re.match(r"^depends_on\s*:\s*\[", blines[idx]):
        blines[idx] = re.sub(r"\]\s*$", f", {dep}]", blines[idx].rstrip("\n")).replace("[, ", "[") + "\n"
        body = "".join(blines)
    elif isinstance(deps, dict):
        end = idx + 1
        while end < len(blines) and (not blines[end].strip() or _indent(blines[end]) > 0):
            end += 1
        blines[end:end] = [f"  {dep}:\n", "    condition: service_started\n"]
        body = "".join(blines)
    else:
        end = idx + 1
        while end < len(blines) and (not blines[end].strip() or _indent(blines[end]) > 0 or blines[end].lstrip().startswith("-")):
            end += 1
        blines[end:end] = [f"  - {dep}\n"]
        body = "".join(blines)
    return replace_block(text, service, body)


# ------------------------------------------------------------------ 쿠버네티스
def k8s_manifest(item: dict, name: str, image: str, port: int | None, password: str | None) -> str:
    labels = {"app": name}
    container: dict[str, Any] = {"name": name, "image": image}
    docs: list[dict] = []
    if password:
        secret = f"{name}-secret"
        docs.append({"apiVersion": "v1", "kind": "Secret", "metadata": {"name": secret}, "type": "Opaque",
                     "stringData": {"password": password}})
        if item.get("command"):
            container["command"] = [c.replace("{password}", "$(PASSWORD)") for c in item["command"]]
            container["env"] = [{"name": "PASSWORD", "valueFrom": {"secretKeyRef": {"name": secret, "key": "password"}}}]
        env = []
        for k, v in item.get("env", {}).items():
            env.append({"name": k, "valueFrom": {"secretKeyRef": {"name": secret, "key": "password"}}} if "{password}" in v else {"name": k, "value": v})
        if env:
            container["env"] = container.get("env", []) + env
    else:
        env = [{"name": k, "value": v} for k, v in item.get("env", {}).items() if "{password}" not in v]
        if env:
            container["env"] = env
    ports = item.get("ports") or ([port] if port else [])
    if ports:
        container["ports"] = [{"containerPort": p} for p in ports]
        docs.append({"apiVersion": "v1", "kind": "Service", "metadata": {"name": name},
                     "spec": {"selector": labels, "ports": [{"name": f"p{p}", "port": p, "targetPort": p} for p in ports]}})
    pod = {"metadata": {"labels": labels}, "spec": {"containers": [container]}}
    if item.get("data"):
        container["volumeMounts"] = [{"name": "data", "mountPath": item["data"]}]
        docs.append({"apiVersion": "apps/v1", "kind": "StatefulSet", "metadata": {"name": name},
                     "spec": {"serviceName": name, "replicas": 1, "selector": {"matchLabels": labels}, "template": pod,
                              "volumeClaimTemplates": [{"metadata": {"name": "data"}, "spec": {
                                  "accessModes": ["ReadWriteOnce"], "resources": {"requests": {"storage": "5Gi"}}}}]}})
    else:
        docs.append({"apiVersion": "apps/v1", "kind": "Deployment", "metadata": {"name": name},
                     "spec": {"replicas": 1, "selector": {"matchLabels": labels}, "template": pod}})
    return "---\n".join(_dump(d) for d in docs)


# ------------------------------------------------------------------ API
BUILD_RE = re.compile(r"^(\./)?[A-Za-z0-9_][A-Za-z0-9_./-]{0,200}$|^\.$")


class AddIn(BaseModel):
    item: str
    name: str
    image: str = ""
    build: str = ""  # compose 파일 기준 빌드 폴더 (예: ./api). '직접 입력'에서만
    dockerfile: str = ""  # 그 폴더에 Dockerfile 이 없으면 이 템플릿으로 만든다 (python | node | static)
    port: int | None = None
    password: str = ""  # 비우면 자동 생성
    target: str  # 'compose:<파일>' | 'k8s:<새 파일 경로>'
    connect: list[str] = Field(default_factory=list)  # compose: depends_on 을 더할 서비스


@router.post("/services/{service_id}/topology/add")
async def add_node(service_id: int, body: AddIn, request: Request, user: str = Editor) -> dict:
    item = BY_ID.get(body.item)
    if not item:
        raise HTTPException(422, "없는 항목입니다")
    name, build = body.name.strip(), body.build.strip()
    image = body.image.strip() or ("" if build else item["image"])
    if not NAME_RE.match(name):
        raise HTTPException(422, "이름은 영문 소문자, 숫자, - 로 40자까지 씁니다")
    if build and (body.item != "custom" or not BUILD_RE.match(build) or ".." in build.split("/")):
        raise HTTPException(422, "빌드 폴더는 compose 파일 기준 상대 경로로 씁니다 (예: ./api)")
    if (image or not build) and not IMAGE_RE.match(image):
        raise HTTPException(422, "이미지를 입력하세요 (예: redis:7)")
    if body.dockerfile and body.dockerfile not in DOCKERFILES:
        raise HTTPException(422, "없는 Dockerfile 템플릿입니다")
    port = body.port if body.port is not None else item.get("port")
    if port is not None and not 0 < port < 65536:
        raise HTTPException(422, "포트가 올바르지 않습니다")
    kind, _, path = body.target.partition(":")
    password = (body.password or secrets.token_urlsafe(18)) if item["password"] else None

    svc, _ = await files._service(service_id)
    try:
        current = await files._read(svc, path)
    except HTTPException:
        current = ""  # 새 파일
    if kind == "compose":
        if password:
            # 비밀값을 .env 에 쓰므로 다시 인증이 필요하다 (환경변수 수정과 같다)
            await auth.require_elevated(request)
            await files._service(service_id, (0, 5, 0))
        block, volume = compose_body(item, name, image, port, bool(password), build)
        new = add_compose_service(current, name, block, volume)
        for dep_of in body.connect:
            new = add_depends_on(new, dep_of, name)
    elif kind == "k8s":
        if build:
            raise HTTPException(422, "쿠버네티스는 이미지가 필요합니다. 빌드한 이미지를 레지스트리에 올린 뒤 이미지로 넣으세요")
        if current.strip():
            raise HTTPException(409, f"{path} 파일이 이미 있습니다")
        new = k8s_manifest(item, name, image, port, password)
    else:
        raise HTTPException(422, "넣을 곳을 고르세요")
    if files.yaml_error(new):
        raise HTTPException(422, files.yaml_error(new))
    # 빌드 폴더에 Dockerfile 이 없으면 템플릿으로 만든다 (있으면 그대로 둔다)
    dockerfile = _build_path(path, build) if build else None
    if dockerfile and body.dockerfile:
        await files._service(service_id, (0, 6, 0))
        try:
            existing = await files._read(svc, dockerfile)
        except HTTPException:
            existing = None
        if existing is None:
            await files._write(svc, dockerfile, "", DOCKERFILES[body.dockerfile]["content"], user, f"{name} Dockerfile 만들기")
    await files._write(svc, path, current, new, user, f"{item['name']} {name} 추가")
    if kind == "compose" and password:
        env_key = _env_name(name)
        await files._ask(svc, {"type": "env_set", "path": ".env", "key": env_key, "value": password})
        await auth.audit(request, user, "env.set", f"{svc.server_id}:{svc.name}/.env {env_key}")
    return {"file": path, "node": f"{'compose' if kind == 'compose' else ('StatefulSet' if item.get('data') else 'Deployment')}:{name}"}
