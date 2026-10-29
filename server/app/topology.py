"""서비스 폴더의 docker compose · 쿠버네티스 yaml 을 분석해 리소스(노드)와 연결(선)을 만든다.

- 쿠버네티스: Ingress → Service → 워크로드(Deployment·StatefulSet·DaemonSet·Job·CronJob·Pod) → ConfigMap·Secret·PVC,
  HorizontalPodAutoscaler → 대상. 파일에 없는데 가리키는 리소스는 missing 노드로 보여 준다.
- compose: services 의 각 서비스, depends_on, 이름 있는 볼륨.

노드를 고치거나 지울 때는 파일 전체를 다시 쓰지 않고 그 문서(---로 나뉜 부분)나 서비스 블록만 바꿔 끼운다.
그래서 주석과 다른 리소스는 그대로 남는다.
"""

from __future__ import annotations

import asyncio
import posixpath
import re
from typing import Any

import yaml
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from . import files
from .auth import require_editor, require_user
from .hub import hub
from .services import sha

router = APIRouter(prefix="/api/services/{service_id}/topology")
Member = Depends(require_user)
Editor = Depends(require_editor)

SEP_RE = re.compile(r"^---(?:\s.*)?$")
SERVICES_RE = re.compile(r"^services\s*:\s*(#.*)?$")
KEY_RE = re.compile(r"^(\s*)([^\s#:'\"][^:]*|'[^']*'|\"[^\"]*\")\s*:")
COMPOSE_NAMES = {"compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"}
WORKLOADS = {"Deployment", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob", "Pod"}
RANK = {"Ingress": 0, "Service": 1, "HorizontalPodAutoscaler": 1, "ConfigMap": 3, "Secret": 3, "PersistentVolumeClaim": 3}
MAX_FILES = 40


# ------------------------------------------------------------------ 텍스트 자르기·끼우기
def _lines(text: str) -> list[str]:
    return text.splitlines(keepends=True)


def doc_ranges(text: str) -> list[tuple[int, int]]:
    """--- 로 나뉜 문서마다 (시작 줄, 끝 줄) — 끝은 포함하지 않음."""
    lines, out, start = _lines(text), [], 0
    for i, line in enumerate(lines):
        if SEP_RE.match(line.rstrip("\r\n")):
            out.append((start, i))
            start = i + 1
    out.append((start, len(lines)))
    return out


def _ensure_nl(s: str) -> str:
    return s if not s or s.endswith("\n") else s + "\n"


def replace_doc(text: str, index: int, new: str) -> str:
    lines = _lines(text)
    s, e = doc_ranges(text)[index]
    return "".join(lines[:s]) + _ensure_nl(new) + "".join(lines[e:])


def delete_doc(text: str, index: int) -> str:
    lines = _lines(text)
    ranges = doc_ranges(text)
    s, e = ranges[index]
    if index > 0:
        s -= 1  # 앞의 --- 도 지운다
    elif e < len(lines):
        e += 1  # 첫 문서면 뒤의 --- 를 지운다
    return "".join(lines[:s] + lines[e:])


def _indent(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _blank_or_comment(line: str) -> bool:
    return not line.strip() or line.lstrip().startswith("#")


def compose_blocks(text: str) -> tuple[dict[str, tuple[int, int]], int]:
    """compose 파일의 services 아래 서비스마다 (시작 줄, 끝 줄)과 그 들여쓰기."""
    lines = _lines(text)
    top = next((i for i, l in enumerate(lines) if SERVICES_RE.match(l.rstrip("\r\n"))), None)
    if top is None:
        return {}, 0
    child = next((_indent(l) for l in lines[top + 1:] if not _blank_or_comment(l)), 0)
    if child == 0:
        return {}, 0
    blocks: dict[str, tuple[int, int]] = {}
    cur, start = None, 0

    def close(end: int) -> None:
        while end > start and _blank_or_comment(lines[end - 1]):
            end -= 1  # 뒤의 빈 줄·주석은 다음 서비스 몫
        blocks[cur] = (start, end)

    end_all = len(lines)
    for i in range(top + 1, len(lines)):
        line = lines[i]
        if _blank_or_comment(line):
            continue
        ind = _indent(line)
        if ind == 0:
            end_all = i  # services 다음 최상위 키 (volumes: 등)
            break
        m = KEY_RE.match(line)
        if ind == child and m:
            if cur is not None:
                close(i)
            cur, start = m[2].strip("'\""), i
    if cur is not None:
        close(end_all)
    return blocks, child


def _dedent(block: str, n: int) -> str:
    return "".join(l[n:] if l.startswith(" " * n) else l for l in _lines(block))


def _reindent(block: str, n: int) -> str:
    return "".join((" " * n + l) if l.strip() else l for l in _lines(_ensure_nl(block)))


def block_body(text: str, name: str) -> tuple[str, int] | None:
    """서비스 블록에서 이름 줄(redis:)을 뺀 내용과 그 들여쓰기. 한 줄에 쓴 블록(redis: {image: x})이면 None."""
    blocks, _ = compose_blocks(text)
    if name not in blocks:
        return None
    s, e = blocks[name]
    lines = _lines(text)
    after = lines[s].split(":", 1)[1].split("#", 1)[0].strip() if ":" in lines[s] else ""
    if after:
        return None
    body = lines[s + 1:e]
    indent = next((_indent(l) for l in body if not _blank_or_comment(l)), 0)
    return (_dedent("".join(body), indent) if indent else "".join(body)), indent


def replace_block(text: str, name: str, new_body: str | None) -> str:
    """서비스 블록의 내용(이름 줄 아래)을 바꾸거나, None 이면 블록을 통째로 지운다. 이름 줄은 그대로 둔다."""
    blocks, child = compose_blocks(text)
    if name not in blocks:
        raise HTTPException(409, f"'{name}' 서비스를 파일에서 찾지 못했습니다. 다시 불러오세요")
    s, e = blocks[name]
    lines = _lines(text)
    if new_body is None:
        return "".join(lines[:s] + lines[e:])
    found = block_body(text, name)
    indent = found[1] if found and found[1] > child else child + 2
    return "".join(lines[:s + 1]) + _reindent(new_body, indent) + "".join(lines[e:])


# ------------------------------------------------------------------ 분석
def _get(d: Any, *path: str, default: Any = None) -> Any:
    for p in path:
        if not isinstance(d, dict):
            return default
        d = d.get(p)
    return default if d is None else d


def _pod(kind: str, obj: dict) -> tuple[dict, dict]:
    """워크로드의 (파드 spec, 파드 라벨)."""
    if kind == "Pod":
        return _get(obj, "spec", default={}), _get(obj, "metadata", "labels", default={})
    tpl = _get(obj, "spec", "jobTemplate", "spec", "template", default={}) if kind == "CronJob" else _get(obj, "spec", "template", default={})
    return _get(tpl, "spec", default={}), _get(tpl, "metadata", "labels", default={})


def _containers(spec: dict) -> list[dict]:
    return [c for c in (spec.get("initContainers") or []) + (spec.get("containers") or []) if isinstance(c, dict)]


class Graph:
    def __init__(self) -> None:
        self.nodes: dict[str, dict] = {}
        self.edges: list[dict] = []
        self.by_name: dict[tuple[str, str], str] = {}
        self.dockerfiles: dict[str, str] = {}

    def add(self, nid: str, kind: str, name: str, **kw: Any) -> dict:
        n = {"id": nid, "kind": kind, "name": name, "summary": [], "rank": RANK.get(kind, 2), **kw}
        self.nodes[nid] = n
        self.by_name.setdefault((kind, name), nid)
        return n

    def ref(self, kind: str, name: str) -> str:
        """이름으로 노드를 찾고, 없으면 파일에 없는 리소스(missing)로 만든다."""
        nid = self.by_name.get((kind, name))
        if nid is None:
            nid = f"missing|{kind}|{name}"
            self.add(nid, kind, name, missing=True, editable=False)
        return nid

    def link(self, a: str, b: str, label: str = "", kind: str = "ref") -> None:
        """kind: start = a 가 먼저 켜져야 b 가 켜짐, traffic = 요청이 a 에서 b 로, ref = a 를 b 가 쓴다 / a 가 b 를 가리킨다"""
        if a != b and not any(e["from"] == a and e["to"] == b for e in self.edges):
            self.edges.append({"from": a, "to": b, "label": label, "kind": kind})


def _k8s_summary(kind: str, obj: dict) -> list[list[str]]:
    out: list[list[str]] = []
    spec = obj.get("spec") or {}
    if kind in WORKLOADS:
        if "replicas" in spec:
            out.append(["replicas", str(spec["replicas"])])
        if kind == "CronJob" and spec.get("schedule"):
            out.append(["schedule", str(spec["schedule"])])
        pod, _ = _pod(kind, obj)
        for c in _containers(pod):
            out.append([str(c.get("name", "")), str(c.get("image", ""))])
            ports = [str(p.get("containerPort")) for p in c.get("ports") or [] if isinstance(p, dict) and p.get("containerPort")]
            if ports:
                out.append(["ports", ", ".join(ports)])
    elif kind == "Service":
        out.append(["type", str(spec.get("type") or "ClusterIP")])
        ports = [f"{p.get('port')}→{p.get('targetPort', p.get('port'))}" for p in spec.get("ports") or [] if isinstance(p, dict)]
        if ports:
            out.append(["ports", ", ".join(ports)])
    elif kind == "Ingress":
        for r in spec.get("rules") or []:
            if isinstance(r, dict):
                paths = [p.get("path", "/") for p in _get(r, "http", "paths", default=[]) if isinstance(p, dict)]
                out.append([str(r.get("host") or "*"), ", ".join(paths) or "/"])
    elif kind in ("ConfigMap", "Secret"):
        keys = list((obj.get("data") or {}).keys()) + list((obj.get("stringData") or {}).keys())
        out.append(["keys", ", ".join(keys) or "-"])
    elif kind == "PersistentVolumeClaim":
        out.append(["size", str(_get(spec, "resources", "requests", "storage", default="-"))])
    elif kind == "HorizontalPodAutoscaler":
        out.append(["replicas", f"{spec.get('minReplicas', 1)}~{spec.get('maxReplicas', '?')}"])
    return out


def _k8s_edges(g: Graph, items: list[tuple[str, str, dict]]) -> None:
    for nid, kind, obj in items:
        spec = obj.get("spec") or {}
        if kind in WORKLOADS:
            pod, _ = _pod(kind, obj)
            for c in _containers(pod):
                for ef in c.get("envFrom") or []:
                    if _get(ef, "configMapRef", "name"):
                        g.link(nid, g.ref("ConfigMap", ef["configMapRef"]["name"]), "envFrom")
                    if _get(ef, "secretRef", "name"):
                        g.link(nid, g.ref("Secret", ef["secretRef"]["name"]), "envFrom")
                for ev in c.get("env") or []:
                    if _get(ev, "valueFrom", "configMapKeyRef", "name"):
                        g.link(nid, g.ref("ConfigMap", ev["valueFrom"]["configMapKeyRef"]["name"]), "env")
                    if _get(ev, "valueFrom", "secretKeyRef", "name"):
                        g.link(nid, g.ref("Secret", ev["valueFrom"]["secretKeyRef"]["name"]), "env")
            for v in pod.get("volumes") or []:
                if _get(v, "configMap", "name"):
                    g.link(nid, g.ref("ConfigMap", v["configMap"]["name"]), "volume")
                if _get(v, "secret", "secretName"):
                    g.link(nid, g.ref("Secret", v["secret"]["secretName"]), "volume")
                if _get(v, "persistentVolumeClaim", "claimName"):
                    g.link(nid, g.ref("PersistentVolumeClaim", v["persistentVolumeClaim"]["claimName"]), "volume")
            if kind == "StatefulSet":
                for t in spec.get("volumeClaimTemplates") or []:
                    name = _get(t, "metadata", "name")
                    if name:
                        pvc = g.add(f"{nid}|vct|{name}", "PersistentVolumeClaim", name, editable=False, template=True,
                                    summary=[["size", str(_get(t, "spec", "resources", "requests", "storage", default="-"))]])
                        g.link(nid, pvc["id"], "template")
        elif kind == "Service":
            sel = spec.get("selector") or {}
            if sel:
                for wid, wkind, wobj in items:
                    if wkind in WORKLOADS:
                        _, labels = _pod(wkind, wobj)
                        if labels and all(labels.get(k) == v for k, v in sel.items()):
                            ports = ", ".join(str(p.get("targetPort", p.get("port"))) for p in spec.get("ports") or [] if isinstance(p, dict))
                            g.link(nid, wid, ports, "traffic")
        elif kind == "Ingress":
            backs = [_get(spec, "defaultBackend", "service")] + [
                _get(p, "backend", "service") for r in spec.get("rules") or [] for p in _get(r, "http", "paths", default=[])]
            for r in spec.get("rules") or []:
                for p in _get(r, "http", "paths", default=[]):
                    name = _get(p, "backend", "service", "name")
                    if name:
                        g.link(nid, g.ref("Service", name), f"{r.get('host') or '*'}{p.get('path', '')}", "traffic")
            if _get(backs[0], "name"):
                g.link(nid, g.ref("Service", backs[0]["name"]), "default", "traffic")
        elif kind == "HorizontalPodAutoscaler":
            t = spec.get("scaleTargetRef") or {}
            if t.get("kind") and t.get("name"):
                g.link(nid, g.ref(str(t["kind"]), str(t["name"])), "scale")


def _build_path(compose_path: str, build: Any) -> str | None:
    """compose 의 build 가 가리키는 Dockerfile 경로 (서비스 폴더 기준)."""
    if not build:
        return None
    ctx, df = (build, "Dockerfile") if isinstance(build, str) else (build.get("context", "."), build.get("dockerfile", "Dockerfile"))
    if not isinstance(ctx, str) or "://" in ctx or not isinstance(df, str):
        return None  # git URL 빌드 등
    base = posixpath.dirname(compose_path)
    p = posixpath.normpath(posixpath.join(base, ctx, df))
    return None if p.startswith("..") else p


def _dockerfile_summary(text: str) -> list[list[str]]:
    out, bases, expose, cmd = [], [], [], ""
    for line in text.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) < 2:
            continue
        op, arg = parts[0].upper(), parts[1].strip()
        if op == "FROM":
            bases.append(arg.split()[0])
        elif op == "EXPOSE":
            expose += arg.split()
        elif op in ("CMD", "ENTRYPOINT"):
            cmd = arg
    if bases:
        out.append(["FROM", " → ".join(bases)])
    if expose:
        out.append(["EXPOSE", ", ".join(expose)])
    if cmd:
        out.append([("CMD"), cmd[:80]])
    return out


def _compose(g: Graph, path: str, text: str, data: dict) -> None:
    services = data.get("services") if isinstance(data.get("services"), dict) else {}
    blocks, child = compose_blocks(text)
    lines = _lines(text)
    for name, svc in services.items():
        svc = svc if isinstance(svc, dict) else {}
        s, e = blocks.get(name, (0, 0))
        summary = [["image", str(svc["image"])]] if svc.get("image") else []
        build = _build_path(path, svc.get("build"))
        if build:
            summary.insert(0, ["build", build])
        if svc.get("ports"):
            summary.append(["ports", ", ".join(str(p) for p in svc["ports"])])
        body = block_body(text, str(name))
        g.add(f"{path}|svc|{name}", "compose", str(name), file=path, editable=body is not None, summary=summary,
              text=body[0] if body else _dedent("".join(lines[s:e]), child), rank=0)
    vols: dict[str, list[str]] = {}
    for name, svc in services.items():
        svc = svc if isinstance(svc, dict) else {}
        # build: 의 Dockerfile 을 노드로 붙인다 (서비스 폴더에서 찾지 못하면 missing)
        dfp = _build_path(path, svc.get("build"))
        if dfp:
            did = f"{dfp}|dockerfile|"
            if did not in g.nodes:
                text_ = g.dockerfiles.get(dfp)
                if text_ is None:
                    # 아직 없는 Dockerfile: 패널에서 써서 저장하면 만든다
                    g.add(did, "Dockerfile", dfp, file=dfp, missing=True, editable=True, text="")
                else:
                    g.add(did, "Dockerfile", dfp, file=dfp, editable=True, text=text_, summary=_dockerfile_summary(text_))
            g.link(did, f"{path}|svc|{name}", "build")
            vols.setdefault(did, []).append(f"{path}|svc|{name}")
        deps = svc.get("depends_on") or []
        for d in (deps.keys() if isinstance(deps, dict) else deps):
            if f"{path}|svc|{d}" in g.nodes:
                # 화살표는 켜지는 순서대로: 의존 대상(먼저) → 이 서비스(나중)
                g.link(f"{path}|svc|{d}", f"{path}|svc|{name}", "먼저", "start")
        for v in svc.get("volumes") or []:
            src = v.get("source") if isinstance(v, dict) else str(v).split(":")[0]
            if src and isinstance(data.get("volumes"), dict) and src in data["volumes"]:
                vid = f"{path}|vol|{src}"
                if vid not in g.nodes:
                    g.add(vid, "volume", src, file=path, editable=False)
                g.link(vid, f"{path}|svc|{name}", "volume")
                vols.setdefault(vid, []).append(f"{path}|svc|{name}")
    # 열: 먼저 켜지는 서비스가 왼쪽. 볼륨은 그것을 쓰는 서비스 바로 왼쪽
    ids = [f"{path}|svc|{n}" for n in services]
    depth = {i: 0 for i in ids}
    for _ in range(len(ids)):
        for e in g.edges:
            if e["kind"] == "start" and e["from"] in depth and e["to"] in depth and depth[e["to"]] < depth[e["from"]] + 1:
                depth[e["to"]] = depth[e["from"]] + 1
    shift = 1 if vols else 0
    for i, d in depth.items():
        g.nodes[i]["rank"] = d + shift
    for vid, users in vols.items():
        g.nodes[vid]["rank"] = min(depth[u] for u in users) + shift - 1


def analyze(sources: dict[str, str]) -> dict:
    """{파일 경로: 내용} → {nodes, edges, errors}. Dockerfile 은 compose 의 build 로 이어 붙인다."""
    g, items, errors = Graph(), [], []
    g.dockerfiles = {p: t for p, t in sources.items() if files.is_dockerfile(p)}
    for path, text in sources.items():
        if path in g.dockerfiles:
            continue
        try:
            docs = [yaml.safe_load("".join(_lines(text)[s:e])) for s, e in doc_ranges(text)]
        except yaml.YAMLError:
            errors.append(f"{path}: yaml 문법 오류라 건너뛰었습니다")
            continue
        if path.rsplit("/", 1)[-1] in COMPOSE_NAMES or (len(docs) == 1 and isinstance(docs[0], dict)
                                                         and isinstance(docs[0].get("services"), dict) and "kind" not in docs[0]):
            if isinstance(docs[0], dict):
                _compose(g, path, text, docs[0])
            continue
        lines = _lines(text)
        for i, ((s, e), obj) in enumerate(zip(doc_ranges(text), docs)):
            if not (isinstance(obj, dict) and obj.get("kind") and _get(obj, "metadata", "name")):
                continue
            kind, name = str(obj["kind"]), str(obj["metadata"]["name"])
            body = "".join(lines[s:e])
            secret = kind == "Secret" or files.has_secret(body)
            nid = f"{path}|doc|{i}"
            g.add(nid, kind, name, file=path, editable=not secret, summary=_k8s_summary(kind, obj),
                  text=files.mask_secrets(body) if secret else body,
                  readonly="값은 위 '키'에서 한 번 더 인증하고 보거나 고칩니다" if secret else None)
            items.append((nid, kind, obj))
    _k8s_edges(g, items)
    return {"nodes": list(g.nodes.values()), "edges": g.edges, "errors": errors}


def attach_status(graph: dict, agent_id: str, project: str) -> None:
    """에이전트가 보내는 파드·컨테이너 상태를 노드에 붙인다.

    파드는 이름이 가장 길게 겹치는 워크로드 하나에만 붙인다 (api 와 api-worker 가 있으면 api-worker-xxx 는 api-worker 것).
    compose 컨테이너는 서비스 이름으로 맞춘다.
    """
    st = (hub.status.get(agent_id) or {}).get(project) or {}
    containers = st.get("containers") or []
    groups: dict[str, list[dict]] = {}
    if st.get("kind") == "k8s":
        workloads = sorted((n for n in graph["nodes"] if n["kind"] in WORKLOADS and not n.get("missing")), key=lambda n: -len(n["name"]))
        for c in containers:
            owner = next((n for n in workloads if c["name"] == n["name"] or c["name"].startswith(n["name"] + "-")), None)
            if owner:
                groups.setdefault(owner["id"], []).append(c)
    elif st.get("kind") == "compose":
        for n in graph["nodes"]:
            if n["kind"] == "compose":
                groups[n["id"]] = [c for c in containers if c.get("service") == n["name"]]
    for n in graph["nodes"]:
        mine = groups.get(n["id"])
        if mine:
            ok = sum(1 for c in mine if c["state"] == "running" and c.get("health") != "unhealthy")
            n["status"] = {"ready": ok, "total": len(mine), "tone": "ok" if ok == len(mine) else "warn" if ok else "off"}


# ------------------------------------------------------------------ API
async def _sources(svc) -> tuple[dict[str, str], dict[str, str]]:
    listed = (await files._ask(svc, {"type": "list_files"})).get("files") or []
    paths = [f["path"] for f in listed][:MAX_FILES]
    sem = asyncio.Semaphore(4)

    async def one(p: str) -> tuple[str, str | None]:
        async with sem:
            try:
                return p, await files._read(svc, p)
            except HTTPException:
                return p, None

    texts = {p: t for p, t in await asyncio.gather(*(one(p) for p in paths)) if t is not None}
    return texts, {p: sha(t) for p, t in texts.items()}


@router.get("")
async def topology(service_id: int, user: str = Member) -> dict:
    svc, _ = await files._service(service_id)
    texts, shas = await _sources(svc)
    graph = analyze(texts)
    attach_status(graph, svc.server_id, svc.name)
    return {**graph, "files": shas, "positions": (svc.layout or {}).get("topo") or {}}


class PositionsIn(BaseModel):
    positions: dict[str, dict[str, float]]  # '종류:이름' → {x, y}. 비우면 자동 배치


@router.put("/positions")
async def save_positions(service_id: int, body: PositionsIn, user: str = Member) -> dict:
    from .db import SessionLocal
    from .models import Service

    pos = {k[:300]: {"x": round(float(v.get("x", 0))), "y": round(float(v.get("y", 0)))}
           for k, v in list(body.positions.items())[:500] if isinstance(v, dict)}
    async with SessionLocal() as s:
        svc = await s.get(Service, service_id)
        if not svc:
            raise HTTPException(404, "서비스를 찾을 수 없습니다")
        svc.layout = {**(svc.layout or {}), "topo": pos}
        await s.commit()
    return {"positions": pos}


class NodeIn(BaseModel):
    id: str
    sha: str  # 그 파일의 sha (불러올 때 받은 값)
    text: str | None = None  # None 이면 삭제


def _splice(current: str, nid: str, text: str | None) -> tuple[str, str]:
    """노드 id 로 파일에서 그 부분을 찾아 바꾸거나 지운 내용과, 기록에 남길 설명."""
    try:
        path, part, key = nid.split("|", 2)
    except ValueError:
        raise HTTPException(422, "고칠 수 없는 노드입니다")
    if part == "doc":
        i = int(key)
        ranges = doc_ranges(current)
        if i >= len(ranges):
            raise HTTPException(409, "파일이 바뀌었습니다. 다시 불러오세요")
        old = "".join(_lines(current)[ranges[i][0]:ranges[i][1]])
        if files.has_secret(old) or (text and files.has_secret(text)):
            raise HTTPException(409, "Secret 은 웹에서 고칠 수 없습니다")
        obj = yaml.safe_load(old) if files.yaml_error(old) is None else None
        label = f"{_get(obj, 'kind', default='문서')} {_get(obj, 'metadata', 'name', default=i)}"
        return (delete_doc(current, i) if text is None else replace_doc(current, i, text)), label
    if part == "svc":
        return replace_block(current, key, text), f"compose {key}"
    if part == "dockerfile":
        if text is None:
            raise HTTPException(422, "Dockerfile 은 여기서 지울 수 없습니다. 서비스의 build 를 지우세요")
        return _ensure_nl(text), "Dockerfile"
    raise HTTPException(422, "고칠 수 없는 노드입니다")


def _check_single(nid: str, text: str) -> None:
    """패널에서는 그 리소스 하나만 고친다. 다른 리소스를 덧붙이려면 '노드 추가'를 쓴다."""
    part = nid.split("|")[1] if nid.count("|") >= 2 else ""
    if part == "doc":
        if any(SEP_RE.match(l.rstrip("\r\n")) for l in _lines(text)):
            raise HTTPException(422, "리소스 하나만 쓸 수 있습니다 (---). 새 리소스는 '노드 추가'로 넣으세요")
        obj = yaml.safe_load(text)
        if not (isinstance(obj, dict) and obj.get("kind") and _get(obj, "metadata", "name")):
            raise HTTPException(422, "kind 와 metadata.name 이 있어야 합니다")
    elif part == "svc":
        obj = yaml.safe_load(text)
        if not isinstance(obj, dict):
            raise HTTPException(422, "서비스 설정(image: … 같은 항목)을 써 주세요")
        # redis 패널에 rabbitmq: { image: … } 를 써 넣는 경우: 서비스 안에 서비스가 생긴다
        nested = [k for k, v in obj.items() if isinstance(v, dict) and ("image" in v or "build" in v)]
        if nested:
            raise HTTPException(422, f"'{nested[0]}' 은(는) 다른 서비스처럼 보입니다. 새 서비스는 '노드 추가'로 넣으세요")


@router.put("/node")
async def save_node(service_id: int, body: NodeIn, user: str = Editor) -> dict:
    """노드(리소스) 하나를 고치거나(text) 지운다(text 없음). 파일의 나머지는 그대로 둔다."""
    svc, _ = await files._service(service_id)
    path = body.id.split("|", 1)[0]
    is_df = files.is_dockerfile(path) and body.id.endswith("|dockerfile|")
    try:
        current = await files._read(svc, path)
    except HTTPException:
        if not is_df:
            raise
        current = ""  # 아직 없는 Dockerfile 을 처음 만든다
    if body.sha and sha(current) != body.sha:
        raise HTTPException(409, "파일이 그사이 바뀌었습니다. 다시 불러오세요")
    if not body.sha and current:
        raise HTTPException(409, "그사이 파일이 생겼습니다. 다시 불러오세요")
    if is_df:
        new, label = _splice(current, body.id, body.text)
        if not current and files.dockerfile_error(new):
            raise HTTPException(422, files.dockerfile_error(new))
        files._check_editable(current, new, path)
    else:
        if body.text is not None:
            if files.yaml_error(body.text):
                raise HTTPException(422, files.yaml_error(body.text))
            _check_single(body.id, body.text)
        new, label = _splice(current, body.id, body.text)
        if files.yaml_error(current) is None and files.yaml_error(new):
            raise HTTPException(422, files.yaml_error(new))
    if new == current:
        return {"changed": False}
    await files._write(svc, path, current, new, user, f"{label} {'삭제' if body.text is None else '수정'}")
    return {"changed": True}
