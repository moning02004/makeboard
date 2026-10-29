#!/usr/bin/env python3
"""Makeboard 에이전트.

관리할 서버마다 하나씩 띄운다. 중앙 서버로 먼저 WebSocket 연결을 열고 그 연결로 작업을 받는다.
그래서 이 서버에는 들어오는 포트를 열 필요가 없다.

    python3 makeboard_agent.py --config /etc/makeboard/agent.toml
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import os
import platform
import random
import re
import shutil
import signal
import socket
import sys
import time
import tomllib
from pathlib import Path

import psutil
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, InvalidStatus

VERSION = "0.5.0"
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
VAR_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
VALUE_RE = re.compile(r"^[A-Za-z0-9_.,:/@+=%-]*$")
ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
MAX_MAKEFILE = 1024 * 1024
# 웹에서 보고 고칠 수 있는 설정 파일: 서비스 폴더와 바로 아래 하위 폴더의 yaml
YAML_EXT = (".yaml", ".yml")
MAX_FILE = 512 * 1024
MAX_FILES = 200
SKIP_DIRS = {"node_modules", "vendor", "__pycache__", "venv", ".venv"}
# 환경변수 파일: .env, .env.production, app.env 등 (서비스 폴더 바로 아래만). 값은 키 하나씩만 내보낸다
ENV_NAME_RE = re.compile(r"^(\.env(\.[A-Za-z0-9_.-]+)?|[A-Za-z0-9_.-]+\.env)$")
ENV_LINE_RE = re.compile(r"^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$")
ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
# GNU make 가 찾는 순서. 없으면 Makefile 로 새로 만든다.
MAKEFILE_NAMES = ("GNUmakefile", "makefile", "Makefile")
COMPOSE_FILES = ("compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml")
STATUS_SECONDS = 15
K8S_RETRY_SECONDS = 300  # 클러스터에 닿지 않으면 이만큼 쉬었다가 다시 본다
NAMESPACE_RE = re.compile(r"^\s*(?:NAMESPACE|NS)\s*[:?]?=\s*([a-z0-9]([-a-z0-9]*[a-z0-9])?)\s*$", re.M)
DISK_SECONDS = 300  # 서비스 폴더 크기(du)는 오래 걸릴 수 있어 5분마다


SIZE_UNITS = {"b": 1, "kb": 1000, "mb": 1000**2, "gb": 1000**3, "tb": 1000**4,
              "kib": 1024, "mib": 1024**2, "gib": 1024**3, "tib": 1024**4}


def parse_size(text: str) -> int:
    """docker stats 의 '12.3MiB' 같은 값을 바이트로."""
    m = re.match(r"^\s*([\d.]+)\s*([A-Za-z]*)\s*$", text)
    if not m:
        raise ValueError(text)
    return int(float(m.group(1)) * SIZE_UNITS.get(m.group(2).lower() or "b", 1))


def find_makefile(base: Path) -> Path | None:
    for name in MAKEFILE_NAMES:
        if (base / name).is_file():
            return base / name
    return None

log = logging.getLogger("makeboard.agent")


# ----------------------------------------------------------------------------- config
class Config:
    """설정 파일(선택)과 명령줄 인자를 합친다. 명령줄 값이 우선."""

    def __init__(self, args: argparse.Namespace):
        raw: dict = {}
        if args.config and Path(args.config).exists():
            with open(args.config, "rb") as f:
                raw = tomllib.load(f)
        elif args.config_given:
            sys.exit(f"설정 파일이 없습니다: {args.config}")

        def pick(key: str, cli):
            value = cli if cli is not None else raw.get(key)
            if value in (None, ""):
                sys.exit(f"{key} 값이 필요합니다 (설정 파일 또는 --{key.replace('_', '-')})")
            return value

        self.server: str = pick("server", args.server)
        self.agent_id: str = args.agent_id or raw.get("agent_id") or socket.gethostname().split(".")[0]
        self.token: str = pick("token", args.token)
        self.environment: str = args.environment or raw.get("environment", "prod")
        self.make: str = raw.get("make", "make")
        self.max_jobs: int = int(raw.get("max_concurrent_jobs", 4))
        self.heartbeat: float = float(raw.get("heartbeat_seconds", 5))
        self.rescan: float = float(raw.get("rescan_seconds", 30))

        # 직접 등록한 프로젝트
        self.fixed: dict[str, Path] = {}
        for name, p in (raw.get("projects") or {}).items():
            if not NAME_RE.match(name):
                sys.exit(f"프로젝트 이름은 영문, 숫자, - _ . 만 쓸 수 있습니다: {name}")
            path_ = Path(p).expanduser().resolve()
            if not path_.is_dir():
                log.warning("%s: 폴더가 없습니다: %s", name, path_)
            self.fixed[name] = path_

        # 자동 탐색할 상위 폴더. 바로 아래 폴더가 모두 프로젝트가 된다 (Makefile 은 웹에서 만들 수 있음).
        scan = raw.get("scan") or []
        if isinstance(scan, str):
            scan = [scan]
        self.scan_roots: list[Path] = [Path(p).expanduser().resolve() for p in [*scan, *(args.scan or [])]]
        for root in self.scan_roots:
            if not root.is_dir():
                log.warning("scan 폴더가 없습니다: %s", root)

        self.projects: dict[str, Path] = self.discover()
        if not self.projects and not self.scan_roots:
            sys.exit("[projects] 에 프로젝트를 등록하거나 scan 폴더를 지정하세요")

    def discover(self) -> dict[str, Path]:
        found: dict[str, Path] = {}
        for root in self.scan_roots:
            try:
                children = sorted(root.iterdir())
            except OSError:
                continue
            for d in children:
                if d.name.startswith(".") or not NAME_RE.match(d.name) or not d.is_dir():
                    continue
                if d.name in found:
                    log.warning("같은 이름의 프로젝트가 있어 건너뜁니다: %s", d)
                    continue
                found[d.name] = d.resolve()
        found.update(self.fixed)  # 직접 등록한 것이 우선
        return found


def cpu_info() -> dict:
    """CPU 모델, 소켓 수, 물리 코어, 스레드(논리 코어). 바뀌지 않으므로 처음 한 번만 읽는다."""
    info = {"cpu_model": "", "sockets": 0, "cores_physical": psutil.cpu_count(logical=False) or 0,
            "threads": psutil.cpu_count() or 0}
    try:
        sockets = set()
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            key, _, value = line.partition(":")
            key, value = key.strip(), value.strip()
            if key == "physical id":
                sockets.add(value)
            elif key in ("model name", "Model") and not info["cpu_model"]:  # Model: 라즈베리파이 등 ARM
                info["cpu_model"] = value
        info["sockets"] = len(sockets) or 1
    except OSError:
        if platform.system() == "Darwin":
            try:
                import subprocess
                out = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True, timeout=3)
                info["cpu_model"], info["sockets"] = out.stdout.strip(), 1
            except (OSError, subprocess.SubprocessError):
                pass
    info["cpu_model"] = " ".join(info["cpu_model"].split())[:120]
    return info


def parse_cpu(s: str) -> float | None:
    """kubectl top 의 CPU: '250m' 또는 '1' (코어) -> 밀리코어"""
    try:
        return float(s[:-1]) if s.endswith("m") else float(s) * 1000
    except ValueError:
        return None


def parse_bytes(s: str) -> int | None:
    """kubectl top 의 메모리: '45Mi', '1Gi', '512Ki' -> 바이트"""
    units = {"Ki": 1 << 10, "Mi": 1 << 20, "Gi": 1 << 30, "Ti": 1 << 40, "K": 1000, "M": 1000**2, "G": 1000**3}
    for u, mul in units.items():
        if s.endswith(u):
            try:
                return int(float(s[: -len(u)]) * mul)
            except ValueError:
                return None
    try:
        return int(s)
    except ValueError:
        return None


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


# ------------------------------------------------------------------------------ agent
class Agent:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.ws = None
        self.lock = asyncio.Lock()
        self.jobs: dict[str, asyncio.subprocess.Process] = {}
        self.sem = asyncio.Semaphore(cfg.max_jobs)
        self.reconnect_now = False
        self.status_kick = asyncio.Event()
        self.k8s_retry_at = 0.0

    async def send(self, msg: dict) -> None:
        ws = self.ws
        if ws is None:
            return
        try:
            async with self.lock:
                await ws.send(json.dumps(msg, ensure_ascii=False))
        except ConnectionClosed:
            pass

    # ---- connection loop
    async def run_forever(self) -> None:
        delay = 1.0
        while True:
            try:
                async with connect(self.cfg.server, max_size=8 * 1024 * 1024, ping_interval=20, ping_timeout=20,
                                   open_timeout=15) as ws:
                    await ws.send(json.dumps({
                        "type": "hello", "agent_id": self.cfg.agent_id, "token": self.cfg.token,
                        "hostname": socket.gethostname(), "environment": self.cfg.environment, "version": VERSION,
                        "platform": platform.platform(),
                        "projects": [{"name": n, "path": str(p)} for n, p in self.cfg.projects.items()],
                    }))
                    first = json.loads(await asyncio.wait_for(ws.recv(), 15))
                    if first.get("type") != "welcome":
                        log.error("서버가 연결을 거부했습니다: %s (웹에서 이 서버를 삭제했다면 docker rm -f makeboard-agent 로 에이전트를 지우세요)",
                                  first.get("error"))
                        await asyncio.sleep(30)
                        continue
                    log.info("연결됨: %s (%s)", self.cfg.server, self.cfg.agent_id)
                    self.ws, delay = ws, 1.0
                    beat = asyncio.create_task(self.heartbeat())
                    status = asyncio.create_task(self.status_loop())
                    disk = asyncio.create_task(self.disk_loop())
                    watch = asyncio.create_task(self.watch_projects(ws))
                    try:
                        async for raw in ws:
                            try:
                                msg = json.loads(raw)
                            except json.JSONDecodeError:
                                continue
                            asyncio.create_task(self.handle(msg))
                    finally:
                        beat.cancel()
                        status.cancel()
                        disk.cancel()
                        watch.cancel()
                        self.ws = None
                    if self.reconnect_now:
                        self.reconnect_now = False
                        delay = 0.5
                        continue
            except (OSError, ConnectionClosed, InvalidStatus, asyncio.TimeoutError) as e:
                log.warning("연결 끊김: %s", e)
            delay = min(delay * 2, 30.0)
            await asyncio.sleep(delay + random.random())

    async def watch_projects(self, ws) -> None:
        """scan 폴더에 프로젝트가 생기거나 없어지면 다시 연결해서 서버에 새 목록을 알린다."""
        if not self.cfg.scan_roots:
            return
        while True:
            await asyncio.sleep(self.cfg.rescan)
            # 다시 연결하면 서버가 진행 중인 작업을 실패로 처리하므로, 작업이 없을 때만 반영한다
            if self.jobs:
                continue
            found = await asyncio.to_thread(self.cfg.discover)
            if found == self.cfg.projects:
                continue
            added = sorted(set(found) - set(self.cfg.projects))
            removed = sorted(set(self.cfg.projects) - set(found))
            log.info("프로젝트 목록 변경 (추가: %s, 제거: %s). 다시 연결합니다", added or "-", removed or "-")
            self.cfg.projects = found
            self.reconnect_now = True
            await ws.close()
            return

    # ---- 서비스 상태 (docker compose)
    async def compose_status(self, base: Path) -> dict | None:
        if not any((base / f).is_file() for f in COMPOSE_FILES):
            return None
        try:
            proc = await asyncio.create_subprocess_exec(
                "docker", "compose", "ps", "-a", "--format", "json", cwd=str(base),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            out, err = await asyncio.wait_for(proc.communicate(), 10)
        except FileNotFoundError:
            return {"kind": "compose", "containers": [], "error": "docker 명령을 찾을 수 없습니다"}
        except asyncio.TimeoutError:
            proc.kill()
            return {"kind": "compose", "containers": [], "error": "docker compose ps 가 응답하지 않습니다"}
        if proc.returncode != 0:
            msg = ANSI_RE.sub("", err.decode(errors="replace")).strip().splitlines()
            return {"kind": "compose", "containers": [], "error": (msg[-1] if msg else "docker compose ps 실패")[:300]}
        text = out.decode(errors="replace").strip()
        # compose 2.21 부터는 한 줄에 하나씩(JSON Lines), 그 전에는 JSON 배열
        rows: list = []
        try:
            rows = json.loads(text) if text.startswith("[") else [json.loads(x) for x in text.splitlines() if x.strip()]
        except json.JSONDecodeError:
            return {"kind": "compose", "containers": [], "error": "docker compose ps 결과를 읽지 못했습니다"}
        return {"kind": "compose", "error": None, "containers": [
            {"name": str(r.get("Name", "")), "service": str(r.get("Service", "")), "state": str(r.get("State", "")),
             "health": str(r.get("Health", "")), "status": str(r.get("Status", ""))}
            for r in rows if isinstance(r, dict)]}

    # ---- 서비스 상태 (kubernetes)
    @staticmethod
    def namespace_of(name: str, base: Path) -> str:
        """서비스의 네임스페이스. Makefile 의 NAMESPACE(또는 NS) 변수가 있으면 그것, 없으면 폴더 이름."""
        try:
            m = NAMESPACE_RE.search((base / "Makefile").read_text(errors="replace"))
        except OSError:
            m = None
        return m[1] if m else name.lower().replace("_", "-").replace(".", "-")

    async def _kubectl(self, *args: str, timeout: float = 15) -> str | None:
        try:
            proc = await asyncio.create_subprocess_exec(
                "kubectl", *args, "--request-timeout=8s",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            out, _ = await asyncio.wait_for(proc.communicate(), timeout)
        except (FileNotFoundError, asyncio.TimeoutError):
            return None
        return out.decode(errors="replace") if proc.returncode == 0 else None

    async def k8s_pods(self) -> dict[str, list[dict]] | None:
        """네임스페이스별 파드 상태와 사용량. kubectl 이 없거나 클러스터에 닿지 않으면 None (한동안 다시 묻지 않는다)."""
        if not shutil.which("kubectl") or time.monotonic() < self.k8s_retry_at:
            return None
        text = await self._kubectl("get", "pods", "-A", "-o", "json")
        try:
            items = json.loads(text)["items"] if text else None
        except (json.JSONDecodeError, KeyError, TypeError):
            items = None
        if items is None:
            self.k8s_retry_at = time.monotonic() + K8S_RETRY_SECONDS
            return None
        by_ns: dict[str, list[dict]] = {}
        for p in items:
            meta, st = p.get("metadata") or {}, p.get("status") or {}
            phase = str(st.get("phase") or "Unknown")
            if phase == "Succeeded":  # 끝난 Job 파드는 빼고 센다
                continue
            cs = st.get("containerStatuses") or []
            ready = sum(1 for c in cs if c.get("ready"))
            restarts = sum(int(c.get("restartCount") or 0) for c in cs)
            waiting = next((c["state"]["waiting"].get("reason", "") for c in cs if (c.get("state") or {}).get("waiting")), "")
            state = "restarting" if waiting == "CrashLoopBackOff" else phase.lower()
            if meta.get("deletionTimestamp"):
                state = "exited"
            text_ = waiting or phase
            by_ns.setdefault(str(meta.get("namespace", "")), []).append({
                "name": str(meta.get("name", "")), "service": str(meta.get("name", "")), "state": state,
                "health": "unhealthy" if state == "running" and ready < len(cs) else "",
                "status": f"{text_} · 준비 {ready}/{len(cs)}" + (f" · 재시작 {restarts}" if restarts else "")})
        # 사용량은 metrics-server 가 있을 때만 (k3s 는 기본으로 있다)
        top = await self._kubectl("top", "pods", "-A", "--no-headers")
        if top:
            cores = psutil.cpu_count() or 1
            usage = {}
            for line in top.splitlines():
                parts = line.split()
                if len(parts) >= 4:
                    cpu, mem = parse_cpu(parts[2]), parse_bytes(parts[3])
                    if cpu is not None and mem is not None:
                        # 밀리코어 -> 서버 전체 대비 % (docker stats 와 같은 기준)
                        usage[(parts[0], parts[1])] = {"cpu": round(cpu / 1000 / cores * 100, 2), "mem": mem}
            for ns, pods in by_ns.items():
                for pod in pods:
                    pod.update(usage.get((ns, pod["name"]), {}))
        return by_ns

    async def docker_usage(self) -> dict[str, dict]:
        """실행 중인 모든 컨테이너의 CPU·메모리를 한 번에 잰다 (docker stats 한 번).

        CPU 는 서버 전체 대비 % 로 바꾼다 (docker stats 는 코어 하나를 100% 로 센다).
        """
        try:
            proc = await asyncio.create_subprocess_exec(
                "docker", "stats", "--no-stream", "--format", "{{json .}}",
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
            out, _ = await asyncio.wait_for(proc.communicate(), 20)
        except (FileNotFoundError, asyncio.TimeoutError):
            return {}
        if proc.returncode != 0:
            return {}
        cores = psutil.cpu_count() or 1
        usage: dict[str, dict] = {}
        for line in out.decode(errors="replace").splitlines():
            try:
                r = json.loads(line)
                cpu = float(str(r.get("CPUPerc", "0")).rstrip("%") or 0) / cores
                mem = parse_size(str(r.get("MemUsage", "0")).split("/")[0])
            except (json.JSONDecodeError, ValueError):
                continue
            usage[str(r.get("Name", ""))] = {"cpu": round(cpu, 2), "mem": mem}
        return usage

    async def folder_size(self, base: Path) -> int | None:
        """서비스 폴더 크기(바이트). 읽을 수 없는 하위 폴더는 빼고 센다."""
        try:
            proc = await asyncio.create_subprocess_exec("du", "-sk", str(base),
                                                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL)
        except FileNotFoundError:
            return None
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), 120)
            return int(out.split()[0]) * 1024
        except asyncio.TimeoutError:
            proc.kill()
        except (ValueError, IndexError):
            pass
        return None

    async def disk_loop(self) -> None:
        while True:
            sizes = {}
            for name, base in list(self.cfg.projects.items()):
                size = await self.folder_size(base)
                if size is not None:
                    sizes[name] = size
            await self.send({"type": "disk", "sizes": sizes})
            await asyncio.sleep(DISK_SECONDS)

    async def status_loop(self) -> None:
        """서비스의 컨테이너(compose) 또는 파드(kubernetes) 상태와 사용량을 보낸다. 바뀌었을 때와 1분마다.

        compose 파일이 있으면 compose, 없으면 폴더 이름(또는 Makefile 의 NAMESPACE)과 같은 네임스페이스의 파드를 본다.
        """
        last: dict | None = None
        quiet = 0
        while True:
            report = {}
            rest = {}
            for name, base in list(self.cfg.projects.items()):
                st = await self.compose_status(base)
                if st is not None:
                    report[name] = st
                else:
                    rest[name] = base
            pods = await self.k8s_pods() if rest else None
            for name, base in rest.items():
                found = (pods or {}).get(self.namespace_of(name, base))
                if found:
                    st = {"kind": "k8s", "error": None, "containers": found}
                    if any("cpu" in c for c in found):
                        st["usage"] = {"cpu": round(sum(c.get("cpu", 0) for c in found), 2), "mem": sum(c.get("mem", 0) for c in found)}
                    report[name] = st
            compose = [st for st in report.values() if st["kind"] == "compose"]
            # 실행 중인 컨테이너가 있을 때만 사용량을 잰다
            if any(c["state"] == "running" for st in compose for c in st["containers"]):
                usage = await self.docker_usage()
                for st in compose:
                    total_cpu, total_mem = 0.0, 0
                    for c in st["containers"]:
                        u = usage.get(c["name"])
                        if u:
                            c.update(u)
                            total_cpu += u["cpu"]
                            total_mem += u["mem"]
                    if any("cpu" in c for c in st["containers"]):
                        st["usage"] = {"cpu": round(total_cpu, 2), "mem": total_mem}
            quiet += 1
            if report != last or quiet >= 4:
                await self.send({"type": "status", "projects": report})
                last, quiet = report, 0
            self.status_kick.clear()
            try:
                await asyncio.wait_for(self.status_kick.wait(), STATUS_SECONDS)
            except asyncio.TimeoutError:
                pass

    def _disk_path(self) -> str:
        # 서비스 폴더가 있는 디스크를 본다. 컨테이너에서도 마운트한 호스트 폴더라 호스트 디스크가 잡힌다.
        for p in [*self.cfg.scan_roots, *self.cfg.projects.values()]:
            if Path(p).exists():
                return str(p)
        return "/"

    async def heartbeat(self) -> None:
        cpu = cpu_info()
        psutil.cpu_percent(None)
        net = psutil.net_io_counters()
        t_prev = time.monotonic()
        while True:
            await asyncio.sleep(self.cfg.heartbeat)
            try:
                load = os.getloadavg()
            except OSError:
                load = (0.0, 0.0, 0.0)
            mem = psutil.virtual_memory()
            disk_path = self._disk_path()
            disk = psutil.disk_usage(disk_path)
            now, cur = time.monotonic(), psutil.net_io_counters()
            dt = max(now - t_prev, 0.001)
            rx = max(cur.bytes_recv - net.bytes_recv, 0) / dt
            tx = max(cur.bytes_sent - net.bytes_sent, 0) / dt
            net, t_prev = cur, now
            await self.send({"type": "heartbeat", "metrics": {
                "cpu": round(psutil.cpu_percent(None)), "cores": psutil.cpu_count() or 0,
                "ram": round(mem.percent), "mem_used": mem.total - mem.available, "mem_total": mem.total,
                "disk": round(disk.percent), "disk_used": disk.used, "disk_total": disk.total, "disk_path": disk_path,
                "rx": round(rx), "tx": round(tx),
                "load": [round(x, 2) for x in load], "uptime": round(time.time() - psutil.boot_time()),
                "jobs": len(self.jobs), **cpu,
            }})

    async def handle(self, msg: dict) -> None:
        kind = msg.get("type")
        try:
            if kind == "run":
                await self.run_job(msg)
            elif kind == "cancel":
                await self.cancel(str(msg.get("job_id")))
            elif kind == "read_makefile":
                await self.read_makefile(msg)
            elif kind == "write_makefile":
                await self.write_makefile(msg)
            elif kind == "uninstall":
                await self.uninstall(msg)
            elif kind == "list_files":
                await self.list_files(msg)
            elif kind == "read_file":
                await self.read_file(msg)
            elif kind == "write_file":
                await self.write_file(msg)
            elif kind == "env_list":
                await self.env_list(msg)
            elif kind == "env_get":
                await self.env_get(msg)
            elif kind == "env_set":
                await self.env_set(msg)
        except Exception as e:  # noqa: BLE001
            log.exception("%s 처리 중 오류", kind)
            if msg.get("req_id"):
                await self.send({"type": "reply", "req_id": msg["req_id"], "ok": False, "error": str(e)})

    # ---- 웹에서 서버를 삭제할 때
    async def uninstall(self, msg: dict) -> None:
        """Docker 로 띄운 에이전트면 자기 컨테이너를 지운다. 호스트 설치는 root 권한이 필요해 지우지 못한다.

        컨테이너가 지워지면 이 프로세스도 같이 끝나므로, 결과는 서버가 연결이 끊기는 것으로 확인한다.
        """
        name = os.environ.get("MAKEBOARD_CONTAINER", "makeboard-agent")
        if Path("/.dockerenv").exists() and shutil.which("docker"):
            await self.send({"type": "reply", "req_id": msg["req_id"], "ok": True, "mode": "docker", "container": name})
            await asyncio.sleep(1)
            log.warning("웹에서 서버를 삭제했습니다. 컨테이너 %s 를 제거합니다", name)
            proc = await asyncio.create_subprocess_exec("docker", "rm", "-f", name,
                                                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            out, _ = await proc.communicate()
            # 여기까지 왔다면 제거에 실패한 것
            log.error("컨테이너를 제거하지 못했습니다: %s", out.decode(errors="replace").strip())
            return
        await self.send({"type": "reply", "req_id": msg["req_id"], "ok": False, "mode": "host",
                         "error": "호스트에 직접 설치한 에이전트는 root 권한이 필요해 자동으로 지울 수 없습니다"})

    # ---- makefile
    def _makefile(self, project: str) -> Path:
        base = self.cfg.projects.get(project)
        if base is None:
            raise ValueError(f"등록되지 않은 프로젝트입니다: {project}")
        return find_makefile(base) or base / "Makefile"

    async def read_makefile(self, msg: dict) -> None:
        path = self._makefile(str(msg.get("project")))
        if not path.exists():
            # 아직 Makefile 이 없는 폴더. 웹에서 템플릿으로 만들 수 있게 빈 내용으로 알린다.
            await self.send({"type": "reply", "req_id": msg["req_id"], "ok": True, "content": "", "sha": sha256(""),
                             "missing": True})
            return
        if path.stat().st_size > MAX_MAKEFILE:
            raise ValueError("Makefile이 너무 큽니다 (1MB 초과)")
        text = path.read_text(encoding="utf-8")
        await self.send({"type": "reply", "req_id": msg["req_id"], "ok": True, "content": text, "sha": sha256(text)})

    async def write_makefile(self, msg: dict) -> None:
        path = self._makefile(str(msg.get("project")))
        content = str(msg.get("content") or "")
        if len(content.encode()) > MAX_MAKEFILE:
            raise ValueError("Makefile이 너무 큽니다 (1MB 초과)")
        current = path.read_text(encoding="utf-8") if path.exists() else ""
        if sha256(current) != msg.get("expected_sha"):
            await self.send({"type": "reply", "req_id": msg["req_id"], "ok": False,
                             "error": "서버의 Makefile이 그사이 바뀌었습니다. 다시 불러온 뒤 편집하세요"})
            return
        owner = path.stat() if path.exists() else path.parent.stat()
        bak = path.with_name("Makefile.makeboard.bak")
        if path.exists():
            bak.write_text(current, encoding="utf-8")
        tmp = path.with_name(".Makefile.makeboard.tmp")
        tmp.write_text(content, encoding="utf-8")
        os.chmod(tmp, owner.st_mode & 0o777 if path.exists() else 0o644)
        # 컨테이너에서 root 로 돌 때도 파일 소유자는 원래대로 둔다
        if os.geteuid() == 0:
            for f in (tmp, bak):
                if f.exists():
                    os.chown(f, owner.st_uid, owner.st_gid)
        os.replace(tmp, path)
        log.info("Makefile 저장: %s", path)
        await self.send({"type": "reply", "req_id": msg["req_id"], "ok": True, "sha": sha256(content)})

    # ---- 설정 파일 (yaml)
    def _project_file(self, project: str, rel: str) -> tuple[Path, Path]:
        """서비스 폴더 안의 yaml 파일 경로. 폴더 밖(.., 절대 경로, 밖을 가리키는 링크)이나 yaml 이 아니면 거절한다."""
        base = self.cfg.projects.get(project)
        if base is None:
            raise ValueError(f"등록되지 않은 프로젝트입니다: {project}")
        rel_path = Path(rel)
        if not rel or rel_path.is_absolute() or ".." in rel_path.parts or rel_path.suffix.lower() not in YAML_EXT \
                or any(p.startswith(".") for p in rel_path.parts) or len(rel_path.parts) > 2:
            raise ValueError(f"열 수 없는 파일입니다: {rel}")
        root = base.resolve()
        path = (root / rel_path).resolve()
        if root not in path.parents:
            raise ValueError(f"서비스 폴더 밖의 파일입니다: {rel}")
        return root, path

    async def list_files(self, msg: dict) -> None:
        base = self.cfg.projects.get(str(msg.get("project")))
        if base is None:
            raise ValueError("등록되지 않은 프로젝트입니다")
        root, files = base.resolve(), []
        candidates = sorted(root.iterdir()) if root.is_dir() else []
        for d in [c for c in candidates if c.is_dir() and not c.name.startswith(".") and c.name not in SKIP_DIRS]:
            try:
                candidates += sorted(d.iterdir())
            except OSError:
                continue
        for f in candidates:
            if len(files) >= MAX_FILES:
                break
            if f.suffix.lower() in YAML_EXT and f.is_file() and not f.name.startswith("."):
                real = f.resolve()
                if root in real.parents:
                    files.append({"path": f.relative_to(root).as_posix(), "size": f.stat().st_size})
        await self.send({"type": "reply", "req_id": msg["req_id"], "ok": True, "files": files})

    async def read_file(self, msg: dict) -> None:
        _, path = self._project_file(str(msg.get("project")), str(msg.get("path") or ""))
        if not path.is_file():
            raise ValueError("파일이 없습니다")
        if path.stat().st_size > MAX_FILE:
            raise ValueError("파일이 너무 큽니다 (512KB 초과)")
        text = path.read_text(encoding="utf-8", errors="replace")
        await self.send({"type": "reply", "req_id": msg["req_id"], "ok": True, "content": text, "sha": sha256(text)})

    async def write_file(self, msg: dict) -> None:
        _, path = self._project_file(str(msg.get("project")), str(msg.get("path") or ""))
        content = str(msg.get("content") or "")
        if len(content.encode()) > MAX_FILE:
            raise ValueError("파일이 너무 큽니다 (512KB 초과)")
        current = path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""
        if sha256(current) != msg.get("expected_sha"):
            await self.send({"type": "reply", "req_id": msg["req_id"], "ok": False,
                             "error": "서버의 파일이 그사이 바뀌었습니다. 다시 불러온 뒤 고치세요"})
            return
        owner = path.stat() if path.exists() else path.parent.stat()
        tmp = path.with_name(f".{path.name}.makeboard.tmp")
        tmp.write_text(content, encoding="utf-8")
        os.chmod(tmp, owner.st_mode & 0o777 if path.exists() else 0o644)
        if os.geteuid() == 0:
            os.chown(tmp, owner.st_uid, owner.st_gid)
        os.replace(tmp, path)
        log.info("파일 저장: %s", path)
        await self.send({"type": "reply", "req_id": msg["req_id"], "ok": True, "sha": sha256(content)})

    # ---- 환경변수 파일 (.env)
    def _env_file(self, project: str, name: str) -> Path:
        base = self.cfg.projects.get(project)
        if base is None:
            raise ValueError(f"등록되지 않은 프로젝트입니다: {project}")
        if not ENV_NAME_RE.match(name or ""):
            raise ValueError(f"환경변수 파일이 아닙니다: {name}")
        root = base.resolve()
        path = (root / name).resolve()
        if path.parent != root:
            raise ValueError("서비스 폴더 밖의 파일입니다")
        return path

    @staticmethod
    def _env_value(raw: str) -> str:
        v = raw.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "'\"":
            v = re.sub(r'\\(["\\])', r'\1', v[1:-1]) if v[0] == '"' else v[1:-1]
        elif " #" in v:
            v = v.split(" #", 1)[0].rstrip()  # 따옴표 없는 값 뒤의 주석
        return v

    async def env_list(self, msg: dict) -> None:
        """키 이름만 보낸다. 값은 보내지 않는다."""
        base = self.cfg.projects.get(str(msg.get("project")))
        if base is None:
            raise ValueError("등록되지 않은 프로젝트입니다")
        out = []
        for f in sorted(base.resolve().iterdir()) if base.is_dir() else []:
            if f.is_file() and ENV_NAME_RE.match(f.name) and f.resolve().parent == base.resolve():
                text = f.read_text(encoding="utf-8", errors="replace")
                keys = []
                for line in text.splitlines():
                    m = ENV_LINE_RE.match(line)
                    if m:
                        keys.append({"key": m[2], "empty": not self._env_value(m[3])})
                out.append({"path": f.name, "sha": sha256(text), "keys": keys})
        await self.send({"type": "reply", "req_id": msg["req_id"], "ok": True, "files": out})

    async def env_get(self, msg: dict) -> None:
        path = self._env_file(str(msg.get("project")), str(msg.get("path")))
        key = str(msg.get("key") or "")
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            m = ENV_LINE_RE.match(line)
            if m and m[2] == key:
                await self.send({"type": "reply", "req_id": msg["req_id"], "ok": True, "value": self._env_value(m[3])})
                return
        raise ValueError(f"{key} 키가 없습니다")

    async def env_set(self, msg: dict) -> None:
        """키 하나를 바꾸거나(value) 더하거나 지운다(value 가 None). 다른 줄과 주석은 그대로 둔다."""
        path = self._env_file(str(msg.get("project")), str(msg.get("path")))
        key, value = str(msg.get("key") or ""), msg.get("value")
        if not ENV_KEY_RE.match(key):
            raise ValueError("키는 영문, 숫자, _ 로 쓰고 숫자로 시작할 수 없습니다")
        if value is not None and ("\n" in str(value) or "\r" in str(value)):
            raise ValueError("값에 줄바꿈을 넣을 수 없습니다")
        text = path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""
        if msg.get("expected_sha") and sha256(text) != msg["expected_sha"]:
            await self.send({"type": "reply", "req_id": msg["req_id"], "ok": False,
                             "error": "파일이 그사이 바뀌었습니다. 다시 불러오세요"})
            return
        if value is not None:
            v = str(value)
            needs_quote = v == "" or any(c in v for c in " #'\"$`\\")
            # 따옴표가 필요하면 작은따옴표(그대로 읽힘, compose 가 $ 를 변수로 바꾸지 않음). 값에 ' 가 있으면 큰따옴표로 이스케이프
            if not needs_quote or not v:
                line_val = v
            elif "'" not in v:
                line_val = f"'{v}'"
            else:
                line_val = '"' + v.replace("\\", "\\\\").replace('"', '\\"') + '"'
        lines, found = text.splitlines(keepends=True), False
        out = []
        for line in lines:
            m = ENV_LINE_RE.match(line)
            if m and m[2] == key and not found:
                found = True
                if value is not None:
                    out.append(f"{m[1] or ''}{key}={line_val}\n")
                continue
            out.append(line)
        if not found:
            if value is None:
                raise ValueError(f"{key} 키가 없습니다")
            if out and not out[-1].endswith("\n"):
                out[-1] += "\n"
            out.append(f"{key}={line_val}\n")
        new = "".join(out)
        owner = path.stat() if path.exists() else path.parent.stat()
        tmp = path.with_name(f".{path.name}.makeboard.tmp")
        tmp.write_text(new, encoding="utf-8")
        os.chmod(tmp, owner.st_mode & 0o777 if path.exists() else 0o600)
        if os.geteuid() == 0:
            os.chown(tmp, owner.st_uid, owner.st_gid)
        os.replace(tmp, path)
        log.info("환경변수 %s %s: %s", "삭제" if value is None else "저장", key, path)
        await self.send({"type": "reply", "req_id": msg["req_id"], "ok": True, "sha": sha256(new)})

    # ---- jobs
    async def run_job(self, msg: dict) -> None:
        job_id = str(msg.get("job_id"))
        project, target, vars_ = str(msg.get("project")), str(msg.get("target")), msg.get("vars") or {}
        base = self.cfg.projects.get(project)
        error = None
        if base is None:
            error = f"등록되지 않은 프로젝트입니다: {project}"
        elif not NAME_RE.match(target):
            error = f"명령어 이름이 올바르지 않습니다: {target}"
        else:
            for k, v in vars_.items():
                if not VAR_RE.match(str(k)) or not VALUE_RE.match(str(v)):
                    error = f"인자 {k} 값에 쓸 수 없는 문자가 있습니다"
        if error:
            await self.send({"type": "done", "job_id": job_id, "exit_code": None, "error": error})
            return

        argv = [self.cfg.make, "--no-print-directory", target, *[f"{k}={v}" for k, v in vars_.items()]]
        timeout = float(msg.get("timeout") or 3600)
        async with self.sem:
            await self._execute(job_id, argv, base, timeout)

    async def _execute(self, job_id: str, argv: list[str], cwd: Path, timeout: float) -> None:
        t0 = time.monotonic()
        buf: list[list] = []
        env = {**os.environ, "PYTHONUNBUFFERED": "1", "MAKEBOARD": "1"}
        try:
            proc = await asyncio.create_subprocess_exec(*argv, cwd=str(cwd), env=env, stdin=asyncio.subprocess.DEVNULL,
                                                        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                                                        start_new_session=True)
        except FileNotFoundError:
            await self.send({"type": "done", "job_id": job_id, "exit_code": None, "error": f"{argv[0]} 을 찾을 수 없습니다"})
            return
        self.jobs[job_id] = proc
        log.info("실행 %s: %s (%s)", job_id[:8], " ".join(argv), cwd)

        async def read(stream, name: str) -> None:
            while True:
                line = await stream.readline()
                if not line:
                    return
                text = ANSI_RE.sub("", line.decode("utf-8", "replace").rstrip("\r\n"))
                buf.append([time.time(), name, text])

        async def flush_loop() -> None:
            while True:
                await asyncio.sleep(0.2)
                await flush()

        async def flush() -> None:
            while buf:
                chunk = buf[:200]
                del buf[:200]
                await self.send({"type": "log", "job_id": job_id, "lines": chunk})

        usage = {"cpu": {}, "rss": 0}

        async def sample() -> None:
            while True:
                try:
                    root = psutil.Process(proc.pid)
                    procs = [root, *root.children(recursive=True)]
                    rss = 0
                    for p in procs:
                        try:
                            ct = p.cpu_times()
                            usage["cpu"][p.pid] = ct.user + ct.system
                            rss += p.memory_info().rss
                        except psutil.Error:
                            pass
                    usage["rss"] = max(usage["rss"], rss)
                except psutil.Error:
                    return
                await asyncio.sleep(1)

        tasks = [asyncio.create_task(read(proc.stdout, "out")), asyncio.create_task(read(proc.stderr, "err"))]
        flusher, sampler = asyncio.create_task(flush_loop()), asyncio.create_task(sample())
        error = None
        try:
            await asyncio.wait_for(proc.wait(), timeout)
        except asyncio.TimeoutError:
            error = f"시간 초과 ({int(timeout)}초)로 중지했습니다"
            await self._kill(proc)
        await asyncio.gather(*tasks, return_exceptions=True)
        flusher.cancel()
        sampler.cancel()
        await flush()
        self.jobs.pop(job_id, None)
        code = proc.returncode
        if code is not None and code < 0 and not error:
            error = f"신호 {-code}로 중지되었습니다"
        await self.send({
            "type": "done", "job_id": job_id, "exit_code": code, "error": error,
            "duration": round(time.monotonic() - t0, 2),
            "cpu_seconds": round(sum(usage["cpu"].values()), 2) if usage["cpu"] else None,
            "max_rss_kb": int(usage["rss"] / 1024) if usage["rss"] else None,
        })
        self.status_kick.set()  # make up / down 직후 상태를 바로 갱신

    async def cancel(self, job_id: str) -> None:
        proc = self.jobs.get(job_id)
        if proc:
            log.info("중지 요청 %s", job_id[:8])
            await self._kill(proc)

    async def _kill(self, proc: asyncio.subprocess.Process) -> None:
        """프로세스 그룹 전체(make와 자식들)에 SIGTERM, 10초 뒤에도 남아 있으면 SIGKILL."""
        for sig in (signal.SIGTERM, signal.SIGKILL):
            if proc.returncode is not None:
                return
            try:
                os.killpg(proc.pid, sig)
            except ProcessLookupError:
                return
            try:
                await asyncio.wait_for(proc.wait(), 10)
                return
            except asyncio.TimeoutError:
                continue


def main() -> None:
    ap = argparse.ArgumentParser(description="Makeboard agent")
    env = os.environ.get
    ap.add_argument("--config", "-c", default=None,
                    help="설정 파일 (기본: $MAKEBOARD_AGENT_CONFIG 또는 /etc/makeboard/agent.toml, 없으면 생략)")
    ap.add_argument("--server", default=env("MAKEBOARD_SERVER"), help="예) ws://192.168.0.4:8000/ws/agent")
    ap.add_argument("--id", dest="agent_id", default=env("MAKEBOARD_AGENT_ID"), help="에이전트 이름 (기본: 호스트명)")
    ap.add_argument("--token", default=env("MAKEBOARD_AGENT_TOKEN"))
    ap.add_argument("--env", dest="environment", default=env("MAKEBOARD_ENVIRONMENT"), help="prod | staging | dev")
    ap.add_argument("--scan", action="append", metavar="DIR",
                    help="이 폴더 바로 아래 폴더를 모두 프로젝트로 등록 (여러 번 지정 가능)")
    ap.add_argument("--verbose", "-v", action="store_true")
    args = ap.parse_args()
    args.config_given = args.config is not None
    if args.config is None:
        args.config = env("MAKEBOARD_AGENT_CONFIG", "/etc/makeboard/agent.toml")
        args.config_given = "MAKEBOARD_AGENT_CONFIG" in os.environ
    if args.scan is None and env("MAKEBOARD_SCAN"):
        args.scan = [p for p in env("MAKEBOARD_SCAN", "").split(":") if p]
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    cfg = Config(args)
    if cfg.projects:
        log.info("프로젝트 %d개: %s", len(cfg.projects), ", ".join(sorted(cfg.projects)))
    else:
        log.warning("프로젝트가 없습니다. scan 폴더 %s 아래에 서비스 폴더가 있는지 확인하세요 "
                    "(Docker 로 실행했다면 Docker 가 돌고 있는 호스트의 폴더가 마운트됩니다)",
                    ", ".join(map(str, cfg.scan_roots)) or "-")
    try:
        asyncio.run(Agent(cfg).run_forever())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
