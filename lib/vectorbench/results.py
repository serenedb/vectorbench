"""Result files (docs/contracts.md section 8), written atomically after every point."""

from __future__ import annotations

import datetime as dt
import json
import os
import platform
from pathlib import Path
from typing import Any


def now_date() -> str:
    return dt.date.today().isoformat()


def os_name() -> str:
    try:
        for line in Path("/etc/os-release").read_text().splitlines():
            if line.startswith("PRETTY_NAME="):
                return line.split("=", 1)[1].strip().strip('"')
    except OSError:
        pass
    return platform.platform()


def host_description() -> str:
    cpus = os.cpu_count() or 0
    model = ""
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.startswith("model name"):
                model = line.split(":", 1)[1].strip()
                break
    except OSError:
        pass
    mem = ""
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemTotal"):
                kb = int(line.split()[1])
                mem = f"{kb / 1024 / 1024:.0f} GiB"
                break
    except OSError:
        pass
    return f"{model or platform.processor() or 'unknown cpu'}, {cpus} vCPU, {mem}".strip(", ")


def write_json_atomic(path: Path, obj: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=1, default=_default))
    tmp.replace(path)


def _default(o: Any) -> Any:
    try:
        import numpy as np

        if isinstance(o, np.integer):
            return int(o)
        if isinstance(o, np.floating):
            return float(o)
        if isinstance(o, np.ndarray):
            return o.tolist()
    except ImportError:
        pass
    raise TypeError(f"not JSON serializable: {type(o).__name__}")


class ResultFile:
    """Accumulates one result object and rewrites `<path>.partial.json` on every change; `finish`
    promotes it to `<path>`."""

    def __init__(self, path: Path, header: dict[str, Any]):
        self.path = path
        self.partial = path.with_name(path.stem + ".partial.json")
        self.obj: dict[str, Any] = dict(header)
        self.obj.setdefault("groups", [])
        # Resume an interrupted run from its partial file, or start a subset rerun (`--groups`) from
        # the published file, so the groups run replace their predecessors and the rest stay.
        for source in (self.partial, self.path):
            if source.exists():
                try:
                    prev = json.loads(source.read_text())
                except json.JSONDecodeError:
                    continue
                if prev.get("dataset") == header.get("dataset"):
                    self.obj["groups"] = prev.get("groups", [])
                break
        self.flush()

    def set(self, **fields: Any) -> None:
        self.obj.update(fields)
        self.flush()

    def upsert_group(self, group: dict[str, Any]) -> None:
        key = (group["key"], group["view"])
        groups = [g for g in self.obj["groups"] if (g["key"], g["view"]) != key]
        groups.append(group)
        self.obj["groups"] = groups
        self.flush()

    def find_group(self, key: str, view: str) -> dict[str, Any] | None:
        for g in self.obj["groups"]:
            if g["key"] == key and g["view"] == view:
                return g
        return None

    def flush(self) -> None:
        write_json_atomic(self.partial, self.obj)

    def finish(self) -> Path:
        write_json_atomic(self.path, self.obj)
        try:
            self.partial.unlink()
        except OSError:
            pass
        return self.path
