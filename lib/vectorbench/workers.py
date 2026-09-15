"""Client worker processes: one process, one connection, one `Client` each (docs/contracts.md section 7,
DESIGN rules 5-7).

The coordinator sends commands over a queue; workers answer over another. A pass starts at a shared
barrier so all clients begin together; each worker walks its share of the query set in fixed order
starting from its own offset, times every query, and stops when its share is done or the deadline has
passed (but not before its part of the minimum). The first pass of a point returns the ids so recall
can be scored."""

from __future__ import annotations

import importlib.util
import logging
import multiprocessing as mp
import os
import sys
import time
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np

log = logging.getLogger(__name__)


@dataclass
class PassSpec:
    deadline_s: float
    min_queries: int  # across all workers
    collect_ids: bool
    k: int


def _load_client_class(client_path: Path) -> type:
    spec = importlib.util.spec_from_file_location(f"vb_client_{client_path.parent.name}".replace("-", "_"), client_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {client_path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod  # dataclasses and typing resolve annotations through sys.modules
    spec.loader.exec_module(mod)
    if not hasattr(mod, "Client"):
        raise RuntimeError(f"{client_path} defines no class Client")
    return mod.Client


def _worker_main(
    wid: int,
    nworkers: int,
    client_path: str,
    cfg: dict[str, Any],
    queries_path: str,
    dims: int,
    nq_limit: int | None,
    cpus: list[int] | None,
    cmd_q: mp.Queue,
    res_q: mp.Queue,
    barrier: Any,
) -> None:
    try:
        if cpus:
            try:
                os.sched_setaffinity(0, cpus)
            except OSError:
                pass
        import pyarrow.parquet as pq

        t = pq.read_table(queries_path, columns=["emb"])
        qvec = np.asarray(t.column("emb").combine_chunks().flatten().to_numpy(zero_copy_only=False), dtype=np.float32).reshape(len(t), dims)
        if nq_limit:
            qvec = qvec[:nq_limit]
        nq = len(qvec)
        client = _load_client_class(Path(client_path))(cfg)
        client.connect()
        handle = None
        group_args: list[dict[str, Any]] = [{} for _ in range(nq)]
        res_q.put(("ready", wid, None))
        while True:
            cmd, payload = cmd_q.get()
            if cmd == "stop":
                break
            if cmd == "group":
                group_args = payload["args"]  # list of per-query dicts
                res_q.put(("ok", wid, None))
            elif cmd == "prepare":
                handle = client.prepare_group(payload)
                res_q.put(("ok", wid, None))
            elif cmd == "explain":
                plan = None
                if wid == 0 and hasattr(client, "explain"):
                    qi = int(payload.get("qi", 0))
                    plan = client.explain(handle, qvec[qi], int(payload["k"]), group_args[qi])
                res_q.put(("ok", wid, plan))
            elif cmd == "warmup":
                n = int(payload["n"])
                k = int(payload["k"])
                rng = np.random.default_rng(1000 + wid)
                for qi in rng.integers(0, nq, size=n):
                    client.search(handle, qvec[qi], k, group_args[qi])
                res_q.put(("ok", wid, None))
            elif cmd == "pass":
                spec = PassSpec(**payload)
                my = list(range(wid, nq, nworkers))
                off = (wid * len(my)) // max(nworkers, 1)
                order = my[off:] + my[:off]
                my_min = (spec.min_queries + nworkers - 1) // nworkers
                lat = np.empty(len(order), dtype=np.float64)
                ids_out: list[tuple[int, list[int]]] = []
                barrier.wait()
                t_start = time.perf_counter()
                done = 0
                for qi in order:
                    t0 = time.perf_counter_ns()
                    ids = client.search(handle, qvec[qi], spec.k, group_args[qi])
                    lat[done] = (time.perf_counter_ns() - t0) / 1e6
                    if spec.collect_ids:
                        ids_out.append((qi, [int(x) for x in ids]))
                    done += 1
                    if done >= my_min and (time.perf_counter() - t_start) >= spec.deadline_s:
                        break
                t_end = time.perf_counter()
                res_q.put(("pass", wid, {"lat": lat[:done], "ids": ids_out, "t_start": t_start, "t_end": t_end, "done": done}))
            else:
                res_q.put(("error", wid, f"unknown command {cmd}"))
        client.close()
    except Exception:  # noqa: BLE001
        res_q.put(("error", wid, traceback.format_exc()))


class WorkerPool:
    def __init__(self, n: int, client_path: Path, cfg: dict[str, Any], queries_path: Path, dims: int, cpus: list[int] | None = None, nq_limit: int | None = None):
        self.n = n
        ctx = mp.get_context("fork")
        self.cmd_qs = [ctx.Queue() for _ in range(n)]
        self.res_q = ctx.Queue()
        self.barrier = ctx.Barrier(n + 1)
        self.procs = [
            ctx.Process(
                target=_worker_main,
                args=(i, n, str(client_path), cfg, str(queries_path), dims, nq_limit, cpus, self.cmd_qs[i], self.res_q, self.barrier),
                daemon=True,
            )
            for i in range(n)
        ]
        for p in self.procs:
            p.start()
        self._collect("ready")

    def _collect(self, expect: str) -> list[Any]:
        out: list[Any] = [None] * self.n
        got = 0
        while got < self.n:
            kind, wid, payload = self.res_q.get(timeout=3600)
            if kind == "error":
                self.close()
                raise RuntimeError(f"worker {wid} failed:\n{payload}")
            if kind != expect:
                raise RuntimeError(f"worker {wid}: expected {expect}, got {kind}")
            out[wid] = payload
            got += 1
        return out

    def _broadcast(self, cmd: str, payload: Any, expect: str = "ok") -> list[Any]:
        for q in self.cmd_qs:
            q.put((cmd, payload))
        return self._collect(expect)

    def set_group(self, args: list[dict[str, Any]]) -> None:
        self._broadcast("group", {"args": args})

    def prepare(self, block: str) -> None:
        self._broadcast("prepare", block)

    def explain(self, k: int, qi: int = 0) -> str | None:
        """Plan text from worker 0's client, or None when the client has no explain()."""
        out = self._broadcast("explain", {"k": k, "qi": qi})
        return out[0] if out else None

    def warmup(self, n_per_client: int, k: int) -> None:
        self._broadcast("warmup", {"n": n_per_client, "k": k})

    def run_pass(self, spec: PassSpec) -> dict[str, Any]:
        for q in self.cmd_qs:
            q.put(("pass", spec.__dict__))
        self.barrier.wait()
        t_release = time.perf_counter()
        results = self._collect("pass")
        lat = np.concatenate([r["lat"] for r in results]) if results else np.empty(0)
        t_end = max(r["t_end"] for r in results)
        ids: dict[int, list[int]] = {}
        for r in results:
            for qi, l in r["ids"]:
                ids[qi] = l
        return {"latencies_ms": lat, "wall_s": t_end - t_release, "queries": int(lat.size), "ids": ids}

    def close(self) -> None:
        for q in self.cmd_qs:
            try:
                q.put(("stop", None))
            except Exception:  # noqa: BLE001
                pass
        for p in self.procs:
            p.join(timeout=30)
            if p.is_alive():
                p.terminate()
