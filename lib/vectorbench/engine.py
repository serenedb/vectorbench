"""A participant directory: its scripts, environment and container (docs/contracts.md section 4)."""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from .families import Family

log = logging.getLogger(__name__)

SCRIPTS = ("install", "start", "stop", "check", "load", "data-size", "version")
TAG_RE = re.compile(r"^VECTORBENCH_(PHASES|INFO)=(.*)$", re.M)


@dataclass
class LoadResult:
    seconds: float
    phases: dict[str, float]
    info: dict[str, Any]
    log_tail: str


class Participant:
    def __init__(self, directory: Path):
        self.dir = Path(directory).resolve()
        self.id = self.dir.name
        sp = self.dir / "settings.yml"
        if not sp.exists():
            raise SystemExit(f"{self.dir}: no settings.yml (is this a participant directory?)")
        self.settings: dict[str, Any] = yaml.safe_load(sp.read_text()) or {}
        ident = self.settings.get("participant") or {}
        self.name: str = ident.get("name") or self.id
        self.system: str = ident.get("system") or self.name.split()[0]
        self.index_family: str = ident.get("family") or (self.id.split("-")[-1] if "-" in self.id else "")
        self.tags: list[str] = list(ident.get("tags") or [])
        for s in SCRIPTS:
            p = self.dir / s
            if not p.exists():
                raise SystemExit(f"{self.dir}: missing script {s}")
            if not os.access(p, os.X_OK):
                raise SystemExit(f"{self.dir}/{s} is not executable")

    # ----------------------------------------------------------------- env
    def env(self, family: Family, size: str, data_dir: Path, cpuset: str | None, memory: str | None, index: dict[str, Any] | None = None) -> dict[str, str]:
        dataset = family.dataset_id(size)
        e = dict(os.environ)
        e.update(
            {
                "VECTORBENCH_DATA_DIR": str(data_dir),
                "VECTORBENCH_DATASET": dataset,
                "VECTORBENCH_DATASET_DIR": str(data_dir / dataset),
                "VECTORBENCH_ENGINE_DIR": str(data_dir / "engines" / self.id / dataset),
                "VECTORBENCH_METRIC": family.metric,
                "VECTORBENCH_DIMS": str(family.dims),
                "VECTORBENCH_CPUSET": cpuset or "",
                "VECTORBENCH_MEMORY": memory or "",
                "VECTORBENCH_PARTICIPANT": self.id,
            }
        )
        for k, v in (self.settings.get("env") or {}).items():
            e.setdefault(f"VB_{str(k).upper()}", str(v))
        for k, v in (index or {}).items():
            e[f"VB_INDEX_{str(k).upper()}"] = str(v)
        return e

    # ------------------------------------------------------------- scripts
    def run(self, script: str, env: dict[str, str], timeout: float | None = None, capture: bool = True, check: bool = True) -> subprocess.CompletedProcess[str]:
        cmd = [str(self.dir / script)]
        cp = subprocess.run(cmd, cwd=self.dir, env=env, capture_output=capture, text=True, timeout=timeout)
        if check and cp.returncode != 0:
            tail = (cp.stderr or cp.stdout or "")[-4000:]
            raise RuntimeError(f"{self.id}/{script} exited {cp.returncode}\n{tail}")
        return cp

    def check_ok(self, env: dict[str, str]) -> bool:
        try:
            cp = subprocess.run([str(self.dir / "check")], cwd=self.dir, env=env, capture_output=True, text=True, timeout=30)
            return cp.returncode == 0
        except subprocess.TimeoutExpired:
            return False

    def start(self, env: dict[str, str], timeout: float = 600.0, poll: float = 0.1) -> float:
        """Invoke start, poll check every `poll` seconds, return seconds until the first success."""
        t0 = time.perf_counter()
        self.run("start", env, timeout=timeout)
        while True:
            if self.check_ok(env):
                return time.perf_counter() - t0
            if time.perf_counter() - t0 > timeout:
                raise RuntimeError(f"{self.id}: engine did not become ready within {timeout:.0f}s")
            time.sleep(poll)

    def stop(self, env: dict[str, str], timeout: float = 600.0) -> None:
        self.run("stop", env, timeout=timeout, check=False)
        t0 = time.perf_counter()
        while self.check_ok(env):
            if time.perf_counter() - t0 > 60:
                log.warning("%s: still answering 60s after stop; continuing", self.id)
                break
            time.sleep(0.2)

    def install(self, env: dict[str, str]) -> None:
        self.run("install", env, timeout=3600, capture=False)

    def load(self, env: dict[str, str], timeout: float = 7 * 24 * 3600) -> LoadResult:
        t0 = time.perf_counter()
        proc = subprocess.Popen([str(self.dir / "load")], cwd=self.dir, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        lines: list[str] = []
        assert proc.stdout is not None
        for line in proc.stdout:
            lines.append(line.rstrip("\n"))
            log.info("[load] %s", line.rstrip("\n"))
        rc = proc.wait(timeout=timeout)
        seconds = time.perf_counter() - t0
        out = "\n".join(lines)
        if rc != 0:
            raise RuntimeError(f"{self.id}/load exited {rc}\n{out[-4000:]}")
        phases: dict[str, float] = {}
        info: dict[str, Any] = {}
        for m in TAG_RE.finditer(out):
            try:
                val = json.loads(m.group(2))
            except json.JSONDecodeError as e:
                raise RuntimeError(f"{self.id}/load printed an invalid {m.group(1)} tag: {e}") from e
            if m.group(1) == "PHASES":
                if not isinstance(val, dict) or not all(isinstance(v, (int, float)) for v in val.values()):
                    raise RuntimeError(f"{self.id}/load: VECTORBENCH_PHASES must be an object of numbers")
                phases = {str(k): float(v) for k, v in val.items()}
            else:
                if not isinstance(val, dict):
                    raise RuntimeError(f"{self.id}/load: VECTORBENCH_INFO must be an object")
                info = val
        return LoadResult(seconds, phases, info, out[-4000:])

    def data_size(self, env: dict[str, str]) -> int | None:
        cp = self.run("data-size", env, timeout=600, check=False)
        m = re.search(r"\d+", cp.stdout or "")
        return int(m.group(0)) if m else None

    def version(self, env: dict[str, str]) -> str:
        cp = self.run("version", env, timeout=120, check=False)
        return (cp.stdout or "").strip().splitlines()[-1] if (cp.stdout or "").strip() else "unknown"

    # -------------------------------------------------------------- memory
    def container(self) -> str | None:
        return (self.settings.get("env") or {}).get("container")

    def memory_peak(self, env: dict[str, str] | None = None) -> int | None:
        """Peak memory of the engine, bytes: the container cgroup's memory.peak (memory.current as a
        fallback), or in native mode the server process's VmHWM from its pid file."""
        env = env or {}
        if env.get("VB_BINARY"):
            pidfile = Path(env.get("VECTORBENCH_ENGINE_DIR", "")) / "serened.pid"
            try:
                pid = int(pidfile.read_text().strip())
                for line in Path(f"/proc/{pid}/status").read_text().splitlines():
                    if line.startswith("VmHWM:"):
                        return int(line.split()[1]) * 1024
            except (OSError, ValueError):
                return None
            return None
        name = env.get("VB_CONTAINER") or self.container()
        if not name:
            return None
        try:
            cp = subprocess.run(["docker", "inspect", "-f", "{{.State.Pid}}", name], capture_output=True, text=True, timeout=30)
            pid = int((cp.stdout or "0").strip() or 0)
        except (subprocess.SubprocessError, ValueError):
            return None
        if pid <= 0:
            return None
        try:
            cg = Path(f"/proc/{pid}/cgroup").read_text().splitlines()
        except OSError:
            return None
        rel = None
        for line in cg:
            parts = line.split(":", 2)
            if len(parts) == 3 and parts[0] == "0":
                rel = parts[2]
        if rel is None:
            return None
        base = Path("/sys/fs/cgroup") / rel.lstrip("/")
        for fname in ("memory.peak", "memory.current"):
            p = base / fname
            if p.exists():
                try:
                    return int(p.read_text().strip())
                except (OSError, ValueError):
                    continue
        # The host view of the cgroup may not be readable or may be namespaced; inside the container
        # cgroup v2 mounts the container's own cgroup at the root.
        for fname in ("memory.peak", "memory.current"):
            try:
                cp = subprocess.run(["docker", "exec", name, "cat", f"/sys/fs/cgroup/{fname}"], capture_output=True, text=True, timeout=30)
                if cp.returncode == 0 and cp.stdout.strip().isdigit():
                    return int(cp.stdout.strip())
            except subprocess.SubprocessError:
                continue
        return None

    # ----------------------------------------------------------------- misc
    def connection(self, family: Family | None = None, dataset: str | None = None, index: dict[str, Any] | None = None) -> dict[str, Any]:
        """settings.yml `connection` plus the dataset facts a client needs (contracts section 7)."""
        cfg = dict(self.settings.get("connection") or {})
        if family is not None:
            cfg.update({"metric": family.metric, "dims": family.dims, "dataset": dataset or ""})
        if index is not None:
            cfg["index"] = dict(index)
        return cfg

    def query_file(self) -> Path:
        for name in ("queries.sql", "queries.json"):
            p = self.dir / name
            if p.exists():
                return p
        raise SystemExit(f"{self.dir}: no queries.sql or queries.json")

    def results_dir(self) -> Path:
        d = self.dir / "results"
        d.mkdir(exist_ok=True)
        return d

    def result_path(self, dataset: str, label: str | None = None) -> Path:
        stem = f"{self.id}_{label}_{dataset}" if label else f"{self.id}_{dataset}"
        return self.results_dir() / f"{stem}.json"

    def load_record_path(self, dataset: str) -> Path:
        d = self.results_dir() / "load"
        d.mkdir(exist_ok=True)
        return d / f"{dataset}.json"
