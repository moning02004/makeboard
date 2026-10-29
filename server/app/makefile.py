"""Makefile <-> 노드 모델 변환.

모델(JSON) 구조
----------------
{
  "vars":  [{"name": "NS", "op": "?=", "v": "prod", "comments": []}, ...],
  "nodes": {"deploy": {...}, ...},
  "order": ["help", "pull", ...],          # 파일에 쓰는 순서 (그룹은 첫 등장 순)
  "extra": ["export FOO", "%.o: %.c", ...], # 해석하지 않고 그대로 보존하는 줄
  "readonly": null | "이유"                 # 웹에서 편집하면 안 되는 파일
}

노드 종류 (kind)
- help   : 기본 명령어. ## 주석으로 목록 출력
- cmd    : 명령어 줄을 직접 실행
- comp   : 복합 명령어. mode=seq 는 `$(MAKE) a` 여러 줄, mode=par 는 `$(MAKE) -j a b`
- preset : 인자를 고정한 바로가기. `$(MAKE) target VAR=value`
"""

from __future__ import annotations

import re
from typing import Any

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
VAR_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# 실행 시 넘기는 인자 값. 레시피 안에서 셸로 그대로 펼쳐지므로 셸 메타문자를 막는다.
VALUE_RE = re.compile(r"^[A-Za-z0-9_.,:/@+=%-]*$")

ASSIGN_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\s*(\?=|::=|:=|\+=|=)\s*(.*)$")
TARGET_RE = re.compile(r"^([^:=#\s][^:=#]*?)\s*:(?![:=])\s*([^#]*?)\s*(?:##\s*(.*))?$")
MAKE_RE = re.compile(r"^[@\-+]*\$\(MAKE\)\s+(.*)$")
DIRECTIVE_RE = re.compile(r"^(ifeq|ifneq|ifdef|ifndef|else|endif|define|endef|include|-include|sinclude)\b")

VAR_OPS = {"?=", ":=", "::=", "=", "+="}
KINDS = {"help", "cmd", "comp", "preset"}

HELP_DESC = "사용 가능한 명령어 보기"
HELP_RECIPE = (
    r"""@awk 'BEGIN {FS = ":.*##"; printf "사용법: make \033[36m<명령어>\033[0m [변수=값]\n"} """
    r"""/^[a-zA-Z0-9_.-]+:.*?##/ { n = $$1; d = $$2; sub(/^ +/, "", d); w = 28 - length(n); if (w < 3) w = 3; """
    r"""s = ""; for (i = 0; i < w; i++) s = s "-"; printf "  \033[36m%s\033[0m \033[2m%s\033[0m %s\n", n, s, d } """
    r"""/^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) }' $(MAKEFILE_LIST)"""
)


# --------------------------------------------------------------------------- parse
def _logical_lines(text: str) -> list[str]:
    """레시피가 아닌 줄의 `\\` 줄 이음만 합친다. 레시피 줄은 그대로 둔다."""
    out: list[str] = []
    buf = ""
    for line in text.replace("\r\n", "\n").split("\n"):
        if buf:
            buf += " " + line.strip()
        elif line.startswith("\t"):
            out.append(line)
            continue
        else:
            buf = line
        if buf.endswith("\\"):
            buf = buf[:-1].rstrip()
            continue
        out.append(buf)
        buf = ""
    if buf:
        out.append(buf)
    return out


def parse_makefile(text: str) -> dict[str, Any]:
    vars_: list[dict] = []
    raw: dict[str, dict] = {}
    order: list[str] = []
    extra: list[str] = []
    comments: list[str] = []
    group: str | None = None
    cur: dict | None = None
    in_extra = False
    readonly: str | None = None

    for line in _logical_lines(text):
        if line.startswith("\t"):
            if in_extra:
                extra.append(line)
            elif cur is not None and line.strip():
                cur["recipe"].append(line[1:].rstrip())
            continue
        in_extra = False
        t = line.strip()
        if t.startswith("##@"):
            group = t[3:].strip() or None
            cur, comments = None, []
            continue
        if not t:
            comments = []
            continue
        if t.startswith("#"):
            comments.append(line.rstrip())
            continue
        if DIRECTIVE_RE.match(t):
            readonly = "조건문이나 include가 있는 Makefile은 웹에서 편집할 수 없습니다. 실행은 가능합니다."
            extra.extend(comments)
            extra.append(line.rstrip())
            cur, comments = None, []
            continue
        if t.startswith(".DEFAULT_GOAL"):
            cur, comments = None, []
            continue
        m = ASSIGN_RE.match(t)
        if m:
            vars_.append({"name": m[1], "op": m[2], "v": m[3].strip(), "comments": comments})
            cur, comments = None, []
            continue
        m = TARGET_RE.match(t)
        if m:
            names = m[1].split()
            name = names[0]
            if name == ".PHONY":
                cur, comments = None, []
                continue
            if len(names) > 1 or name.startswith(".") or "%" in name or not NAME_RE.match(name):
                # 패턴 규칙, 특수 타깃, 여러 타깃 규칙은 그대로 보존
                extra.extend(comments)
                extra.append(line.rstrip())
                in_extra = True
                cur, comments = None, []
                continue
            r = raw.get(name)
            if r is None:
                r = {"name": name, "deps": [], "recipe": [], "desc": "", "group": group, "comments": comments}
                raw[name] = r
                order.append(name)
            r["deps"].extend(d for d in m[2].split() if d not in r["deps"])
            if m[3]:
                r["desc"] = m[3].strip()
            cur, comments = r, []
            continue
        # 해석할 수 없는 줄 (export 등)
        extra.extend(comments)
        extra.append(line.rstrip())
        cur, comments = None, []

    nodes: dict[str, dict] = {}
    for n in order:
        r = raw[n]
        base = {"name": n, "desc": r["desc"], "group": r["group"], "comments": r["comments"]}
        if n == "help":
            nodes[n] = {**base, "group": None, "kind": "help", "desc": r["desc"] or HELP_DESC}
            continue
        mm = [MAKE_RE.match(l) for l in r["recipe"]]
        if not r["recipe"] and r["deps"]:
            nodes[n] = {**base, "kind": "comp", "mode": "seq", "steps": list(r["deps"])}
            continue
        if r["recipe"] and all(mm) and not r["deps"]:
            parts = [x[1].split() for x in mm if x]
            toks = [p for part in parts for p in part]
            targets = [p for p in toks if not p.startswith("-") and "=" not in p]
            assigns = [p for p in toks if re.match(r"^[A-Za-z_]\w*=", p)]
            if len(parts) == 1 and len(targets) == 1 and assigns:
                args = {a.split("=", 1)[0]: a.split("=", 1)[1] for a in assigns}
                nodes[n] = {**base, "kind": "preset", "target": targets[0], "args": args}
                continue
            par = len(parts) == 1 and any(re.match(r"^-j\d*$", p) for p in toks)
            nodes[n] = {**base, "kind": "comp", "mode": "par" if par else "seq", "steps": targets}
            continue
        node = {**base, "kind": "cmd", "cmds": list(r["recipe"])}
        if r["deps"]:
            node["deps"] = list(r["deps"])  # 선행 타깃이 있는 명령어. make가 알아서 먼저 실행한다.
        nodes[n] = node

    for nd in nodes.values():
        if nd["kind"] == "comp":
            nd["steps"] = [s for s in nd["steps"] if s in nodes and s != nd["name"] and s != "help"]
        if nd["kind"] == "preset" and nd["target"] not in nodes:
            nd.pop("target"), nd.pop("args")
            nd["kind"], nd["cmds"] = "cmd", [l for l in raw[nd["name"]]["recipe"]]

    if "help" not in nodes:
        # 파일에는 아직 없는 help. 실행하면 서버가 같은 형식으로 목록을 만들어 보여주고, 웹에서 한 번 저장하면 파일에 들어간다.
        nodes["help"] = {"name": "help", "desc": HELP_DESC, "group": None, "comments": [], "kind": "help", "virtual": True}
    ordered = ["help"] + [n for n in order if n != "help"]
    return {"vars": vars_, "nodes": nodes, "order": ordered, "extra": extra, "readonly": readonly}


# ------------------------------------------------------------------------ generate
def groups_of(model: dict) -> list[str | None]:
    seen: list[str | None] = []
    for n in model["order"]:
        g = model["nodes"][n].get("group") or None
        if g not in seen:
            seen.append(g)
    return [None] + [g for g in seen if g is not None]


def arg_str(args: dict[str, str]) -> str:
    return " ".join(f"{k}={v}" for k, v in args.items() if v != "")


def node_make(nd: dict) -> str:
    lines = list(nd.get("comments") or [])
    desc = nd.get("desc") or ""
    deps = " " + " ".join(nd["deps"]) if nd.get("deps") else ""
    head = f"{nd['name']}:{deps}{' ## ' + desc if desc else ''}"
    lines.append(head)
    kind = nd["kind"]
    if kind == "help":
        lines.append("\t" + HELP_RECIPE)
    elif kind == "cmd":
        lines.extend("\t" + c for c in nd["cmds"])
    elif kind == "preset":
        lines.append(f"\t$(MAKE) {nd['target']} {arg_str(nd['args'])}")
    elif nd.get("mode") == "par":
        lines.append(f"\t$(MAKE) -j {' '.join(nd['steps'])}")
    else:
        lines.extend(f"\t$(MAKE) {s}" for s in nd["steps"])
    return "\n".join(lines)


def to_makefile(model: dict) -> str:
    out: list[str] = []
    for v in model["vars"]:
        out.extend(v.get("comments") or [])
        out.append(f"{v['name']} {v['op']}{' ' + v['v'] if v['v'] else ''}")
    if model.get("extra"):
        out += ["", *model["extra"]]
    if out:
        out.append("")
    out += [".DEFAULT_GOAL := help", f".PHONY: {' '.join(model['order'])}", ""]
    for g in groups_of(model):
        names = [n for n in model["order"] if (model["nodes"][n].get("group") or None) == g]
        if not names:
            continue
        if g:
            out.append(f"##@ {g}")
        out.extend(node_make(model["nodes"][n]) for n in names)
        out.append("")
    return "\n".join(out).rstrip("\n") + "\n"


# ------------------------------------------------------------------------ helpers
def help_text(model: dict) -> list[str]:
    """HELP_RECIPE 와 같은 형식의 출력 (색 없이)."""
    out = ["사용법: make <명령어> [변수=값]"]
    for g in groups_of(model):
        names = [n for n in model["order"] if (model["nodes"][n].get("group") or None) == g and model["nodes"][n].get("desc")]
        if not names:
            continue
        if g:
            out += ["", g]
        for n in names:
            out.append(f"  {n} {'-' * max(3, 28 - len(n))} {model['nodes'][n]['desc']}")
    return out


def refs_of(nd: dict) -> list[str]:
    if nd["kind"] == "comp":
        return list(nd["steps"])
    if nd["kind"] == "preset":
        return [nd["target"]]
    return []


def collect(model: dict, name: str, acc: list[str] | None = None) -> list[str]:
    """실행에 관여하는 노드 목록 (실행 순서대로, 중복 없이)."""
    acc = [] if acc is None else acc
    if name in acc:
        return acc
    acc.append(name)
    for r in refs_of(model["nodes"][name]):
        collect(model, r, acc)
    return acc


class ModelError(ValueError):
    pass


def _clean_line(s: Any, field: str) -> str:
    if not isinstance(s, str):
        raise ModelError(f"{field} 값이 올바르지 않습니다")
    if "\n" in s or "\r" in s:
        raise ModelError(f"{field}에는 줄바꿈을 넣을 수 없습니다")
    return s


def validate_model(data: Any) -> dict:
    """웹에서 보낸 모델을 검사하고 정리된 사본을 돌려준다."""
    if not isinstance(data, dict):
        raise ModelError("모델 형식이 올바르지 않습니다")
    vars_ = []
    for v in data.get("vars") or []:
        name = _clean_line(v.get("name"), "변수 이름")
        if not VAR_RE.match(name):
            raise ModelError(f"변수 이름이 올바르지 않습니다: {name}")
        op = v.get("op")
        if op not in VAR_OPS:
            raise ModelError(f"{name}의 대입 연산자가 올바르지 않습니다")
        vars_.append({"name": name, "op": op, "v": _clean_line(v.get("v", ""), name).strip(),
                      "comments": [_clean_line(c, "주석") for c in v.get("comments") or [] if c.startswith("#")]})
    nodes_in = data.get("nodes") or {}
    order = data.get("order") or []
    if not isinstance(order, list) or set(order) != set(nodes_in.keys()) or len(order) != len(set(order)):
        raise ModelError("노드 목록과 순서가 맞지 않습니다")
    nodes: dict[str, dict] = {}
    for n in order:
        nd = nodes_in[n]
        if not NAME_RE.match(n) or nd.get("name") != n:
            raise ModelError(f"명령어 이름이 올바르지 않습니다: {n}")
        kind = nd.get("kind")
        if kind not in KINDS:
            raise ModelError(f"{n}의 종류가 올바르지 않습니다")
        if kind == "help" and n != "help":
            raise ModelError("help 종류는 help 노드만 쓸 수 있습니다")
        desc = _clean_line(nd.get("desc") or "", "설명").strip()
        group = _clean_line(nd.get("group") or "", "그룹").strip() or None
        out = {"name": n, "kind": kind, "desc": desc, "group": None if kind == "help" else group,
               "comments": [_clean_line(c, "주석") for c in nd.get("comments") or [] if str(c).startswith("#")]}
        if kind == "cmd":
            cmds = [_clean_line(c, "명령어").rstrip() for c in nd.get("cmds") or []]
            cmds = [c for c in cmds if c.strip()]
            if not cmds:
                raise ModelError(f"{n}: 실행할 명령어를 입력하세요")
            out["cmds"] = cmds
            if nd.get("deps"):
                out["deps"] = [d for d in nd["deps"] if isinstance(d, str) and NAME_RE.match(d)]
        elif kind == "comp":
            steps = nd.get("steps") or []
            if len(steps) < 1:
                raise ModelError(f"{n}: 포함할 명령어를 고르세요")
            out["mode"] = "par" if nd.get("mode") == "par" else "seq"
            out["steps"] = [str(s) for s in steps]
        elif kind == "preset":
            out["target"] = str(nd.get("target") or "")
            args = nd.get("args") or {}
            clean = {}
            for k, v in args.items():
                if not VAR_RE.match(k) or not isinstance(v, str) or not VALUE_RE.match(v):
                    raise ModelError(f"{n}: 인자 {k}의 값에 쓸 수 없는 문자가 있습니다")
                if v:
                    clean[k] = v
            if not clean:
                raise ModelError(f"{n}: 고정할 인자를 하나 이상 입력하세요")
            out["args"] = clean
        nodes[n] = out
    if "help" not in nodes:
        raise ModelError("help 노드는 지울 수 없습니다")
    for nd in nodes.values():
        for r in refs_of(nd):
            if r not in nodes or r == "help":
                raise ModelError(f"{nd['name']}: 없는 명령어를 참조합니다 ({r})")

    def has_cycle(n: str, stack: set[str]) -> bool:
        if n in stack:
            return True
        stack.add(n)
        hit = any(has_cycle(r, stack) for r in refs_of(nodes[n]))
        stack.discard(n)
        return hit

    for n in nodes:
        if has_cycle(n, set()):
            raise ModelError(f"{n}: 명령어가 서로를 참조하고 있습니다")
    ordered = ["help"] + [n for n in order if n != "help"]
    extra = [_clean_line(x, "보존된 줄") for x in data.get("extra") or []]
    return {"vars": vars_, "nodes": nodes, "order": ordered, "extra": extra, "readonly": None}
