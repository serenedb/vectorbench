"""`vectorbench run`: every group of a participant on one dataset size (DESIGN section 4)."""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pyarrow.parquet as pq

from . import __version__, attributes, metrics
from .engine import Participant
from .families import Family, Group
from .prepare import dataset_dir, load_manifest
from .queries import knob_names, ladder_points, load_blocks, resolve_block, resolve_settings, substitute_index, substitute_knobs
from .results import ResultFile, host_description, now_date, os_name
from .workers import PassSpec, WorkerPool

log = logging.getLogger(__name__)

VIEWS = {"throughput": None, "latency": 1}  # clients: None = tier cpus
WARMUP_PER_CLIENT = 100
PASS_DEADLINE_S = 60.0
PASS_MIN_QUERIES = 2000
PASSES = 3
TOTAL_BUDGET_S = 60.0
DEGENERATE_FACTOR = 10


@dataclass
class RunOptions:
    data_dir: Path
    views: list[str] = field(default_factory=lambda: ["throughput", "latency"])
    groups: list[str] | None = None  # group key filters (exact keys or "<filter>/*")
    cpuset: str | None = None
    memory: str | None = None
    tier_cpus: int = 32
    index: bool = False  # install + load
    label: str | None = None
    warmup: int = WARMUP_PER_CLIENT
    passes: int = PASSES
    deadline_s: float = PASS_DEADLINE_S
    min_queries: int = PASS_MIN_QUERIES
    total_budget_s: float = TOTAL_BUDGET_S
    query_limit: int | None = None  # use only the first N queries (development)
    dry_run: bool = False


class GroundTruth:
    def __init__(self, dsdir: Path, family: Family):
        self.dsdir = dsdir
        self.family = family
        self._cache: dict[str, Any] = {}
        self._args: dict[str, dict[str, np.ndarray]] | None = None
        self._qmeta: dict[str, np.ndarray] | None = None

    def case(self, name: str) -> dict[str, np.ndarray]:
        if name not in self._cache:
            z = np.load(self.dsdir / "gt" / f"{name}.npz")
            self._cache[name] = {"ids": z["ids"], "dists": z["dists"], "matches": z["matches"]}
        return self._cache[name]

    def args(self, name: str) -> dict[str, np.ndarray]:
        if self._args is None:
            t = pq.read_table(self.dsdir / "query_args.parquet")
            cols = {c: t.column(c).to_numpy(zero_copy_only=False) for c in ("case", "qid", "v", "lo", "hi", "v2")}
            s = np.asarray(t.column("s").to_pylist(), dtype=object)
            self._args = {}
            for cname in np.unique(cols["case"]):
                m = cols["case"] == cname
                order = np.argsort(cols["qid"][m])
                self._args[str(cname)] = {k: cols[k][m][order] for k in ("v", "lo", "hi", "v2")} | {"s": s[m][order]}
        return self._args[name]

    def per_query_args(self, name: str, nq: int) -> list[dict[str, Any]]:
        spec = self.family.case(name)
        if not spec:
            return [{} for _ in range(nq)]
        a = self.args(name)
        return [attributes.args_for_query(a, i, spec) for i in range(nq)]


def cpu_lists(cpuset: str | None, tier_cpus: int) -> tuple[list[int] | None, list[int] | None]:
    """(engine cpus, client cpus): clients get everything outside the engine's cpuset."""
    total = list(range(os.cpu_count() or 1))
    if not cpuset:
        return None, None
    engine: list[int] = []
    for part in cpuset.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            a, b = part.split("-")
            engine.extend(range(int(a), int(b) + 1))
        else:
            engine.append(int(part))
    clients = [c for c in total if c not in set(engine)]
    return engine, (clients or None)


class PlanCheckError(RuntimeError):
    pass


def check_plan(plan: str, g: Group, rules: dict[str, Any]) -> str | None:
    """settings.yml `plan_rules`: lists of substrings the EXPLAIN output must contain.
    `always` for every group, `approximate` for non-exact groups, `filtered` for filtered groups,
    `exact` for exact groups. Returns a description of the first missing item, or None."""
    kinds = ["always", "exact" if g.exact else "approximate"] + (["filtered"] if g.filter != "none" else [])
    for kind in kinds:
        for needle in rules.get(kind) or []:
            if needle not in plan:
                return f"plan does not contain {needle!r}"
        for needle in rules.get(kind + "_not") or []:
            if needle in plan:
                return f"plan contains {needle!r}"
    return None


def score_pass(p: dict[str, Any]) -> dict[str, Any]:
    lat = p["latencies_ms"]
    st = metrics.stats(lat)
    qps = (lat.size / p["wall_s"]) if p["wall_s"] > 0 else None
    return {"qps": qps, "avg": st["avg"], "p50": st["p50"], "p99": st["p99"], "queries": int(lat.size), "duration": p["wall_s"], "_stats": st}


class Runner:
    def __init__(self, participant: Participant, family: Family, size: str, opts: RunOptions):
        self.p = participant
        self.family = family
        self.size = size
        self.opts = opts
        self.dataset = family.dataset_id(size)
        self.dsdir = dataset_dir(family, size, opts.data_dir)
        self.manifest = load_manifest(family, size, opts.data_dir)
        self.blocks = load_blocks(participant.query_file())
        self.gt = GroundTruth(self.dsdir, family)
        self.nq = int(self.manifest["nq"])
        if opts.query_limit:
            self.nq = min(self.nq, opts.query_limit)
        self.engine_cpus, self.client_cpus = cpu_lists(opts.cpuset, opts.tier_cpus)
        self.index_settings = {**resolve_settings(participant.settings, family, size)["index"], "dims": family.dims, "metric": family.metric}
        self.env = participant.env(family, size, opts.data_dir, opts.cpuset, opts.memory, self.index_settings)

    # ----------------------------------------------------------------- plan
    def selected_groups(self) -> list[Group]:
        groups = self.family.groups()
        if not self.opts.groups:
            return groups
        sel = []
        for g in groups:
            for pat in self.opts.groups:
                if pat == g.key or (pat.endswith("/*") and g.key.rsplit("/", 1)[0] == pat[:-2]):
                    sel.append(g)
                    break
        return sel

    def plan(self) -> list[dict[str, Any]]:
        out = []
        for view in self.opts.views:
            for g in self.selected_groups():
                block = resolve_block(self.blocks, g)
                st = resolve_settings(self.p.settings, self.family, self.size, g)
                pts = [{}] if g.exact else ladder_points(st["ladder"])
                out.append({"view": view, "group": g.key, "supported": block is not None, "points": len(pts), "ladder": st["ladder"] if not g.exact else {}})
        return out

    # ------------------------------------------------------------ general
    def header(self) -> dict[str, Any]:
        return {
            "participant": self.p.id,
            "name": self.p.name,
            "system": self.p.system,
            "family": self.p.index_family,
            "version": None,
            "label": self.opts.label,
            "os": os_name(),
            "date": now_date(),
            "dataset": self.dataset,
            "tags": self.p.tags,
            "hardware": {
                "cpus": len(self.engine_cpus) if self.engine_cpus else (os.cpu_count() or 0),
                "cpuset": self.opts.cpuset,
                "memory": self.opts.memory,
                "host": host_description(),
            },
            "tool_version": __version__,
            "index": {"params": self.index_settings},
        }

    def do_load(self, rf: ResultFile) -> None:
        log.info("install %s", self.p.id)
        self.p.install(self.env)
        log.info("start %s", self.p.id)
        self.p.start(self.env)
        log.info("load %s into %s", self.dataset, self.p.id)
        lr = self.p.load(self.env)
        mem = self.p.memory_peak(self.env)
        size = self.p.data_size(self.env)
        version = self.p.version(self.env)
        record = {
            "dataset": self.dataset,
            "participant": self.p.id,
            "load_time": lr.seconds,
            "load_phases": lr.phases,
            "disk_bytes": size,
            "disk_info": lr.info,
            "memory_peak_load": mem,
            "version": version,
            "date": now_date(),
            "index": {"params": self.index_settings},
        }
        self.p.load_record_path(self.dataset).write_text(json.dumps(record, indent=1))
        rf.set(version=version, load_time=lr.seconds, load_phases=lr.phases, disk_bytes=size, disk_info=lr.info,
               memory_peak={**(rf.obj.get("memory_peak") or {}), "load": mem})
        log.info("load done in %.1fs, %s bytes on disk, peak %s bytes", lr.seconds, size, mem)

    def apply_load_record(self, rf: ResultFile) -> None:
        p = self.p.load_record_path(self.dataset)
        if not p.exists():
            raise SystemExit(f"{self.p.id}: no load record for {self.dataset}; run with --index first")
        rec = json.loads(p.read_text())
        rf.set(version=rec.get("version"), load_time=rec.get("load_time"), load_phases=rec.get("load_phases") or {},
               disk_bytes=rec.get("disk_bytes"), disk_info=rec.get("disk_info") or {},
               memory_peak={**(rf.obj.get("memory_peak") or {}), "load": rec.get("memory_peak_load")})

    # -------------------------------------------------------------- groups
    def degenerate(self, g: Group) -> str | None:
        if g.filter == "none":
            return None
        med = int(np.median(self.gt.case(g.filter)["matches"]))
        if med < DEGENERATE_FACTOR * g.k:
            return f"degenerate: median {med} matching rows < {DEGENERATE_FACTOR * g.k}"
        return None

    def run_group(self, g: Group, view: str, rf: ResultFile, startups: list[float]) -> None:
        clients = VIEWS[view] or self.opts.tier_cpus
        base = {"key": g.key, "filter": g.filter, "k": g.k, "exact": g.exact, "view": view, "clients": clients}
        block = resolve_block(self.blocks, g)
        if block is None:
            rf.upsert_group({**base, "status": "unsupported"})
            return
        reason = self.degenerate(g)
        if reason:
            rf.upsert_group({**base, "status": "n/a", "reason": reason})
            return
        st = resolve_settings(self.p.settings, self.family, self.size, g)
        st["index"] = {**st["index"], "dims": self.family.dims, "metric": self.family.metric}
        try:
            block = substitute_index(block, st["index"])
        except KeyError as e:
            rf.upsert_group({**base, "status": "error", "reason": str(e)})
            return
        points = [{}] if g.exact else ladder_points(st["ladder"])
        missing = knob_names(block) - set(points[0]) if not g.exact else set()
        if missing:
            rf.upsert_group({**base, "status": "error", "reason": f"block uses knobs {sorted(missing)} that the ladder does not define"})
            return
        # restart: startup sample
        log.info("[%s %s] restart", view, g.key)
        self.p.stop(self.env)
        startup = self.p.start(self.env)
        startups.append(startup)
        gt = self.gt.case(g.filter)
        args = self.gt.per_query_args(g.filter, self.nq)
        pool = WorkerPool(clients, self.p.dir / "client.py", self.p.connection(self.family, self.dataset, self.index_settings), self.dsdir / "queries.parquet", self.family.dims, self.client_cpus, nq_limit=self.nq)
        group_rec: dict[str, Any] = {**base, "status": "ok", "block": block, "startup": startup, "points": []}
        try:
            pool.set_group(args)
            for li, knobs in enumerate(points):
                text = substitute_knobs(block, knobs) if knobs else block
                pool.prepare(text)
                if li == 0:
                    plan = pool.explain(g.k)
                    if plan is not None:
                        group_rec["plan"] = plan
                        bad = check_plan(plan, g, self.p.settings.get("plan_rules") or {})
                        if bad:
                            raise PlanCheckError(bad)
                pool.warmup(self.opts.warmup, g.k)
                passes: list[dict[str, Any]] = []
                first_ids: dict[int, list[int]] | None = None
                t_budget = time.perf_counter()
                for pi in range(self.opts.passes):
                    spec = PassSpec(deadline_s=self.opts.deadline_s, min_queries=min(self.opts.min_queries, self.nq), collect_ids=(pi == 0), k=g.k)
                    res = pool.run_pass(spec)
                    if pi == 0:
                        first_ids = res["ids"]
                    passes.append(score_pass(res))
                    if time.perf_counter() - t_budget >= self.opts.total_budget_s:
                        break
                best = max(passes, key=lambda x: (x["qps"] or 0.0))
                assert first_ids is not None
                qis = sorted(first_ids)
                returned = metrics.pad_ids([first_ids[q] for q in qis], g.k)
                rec = metrics.recall(returned, gt["ids"][qis], gt["dists"][qis], g.k)
                short = int(sum(1 for q in qis if len(first_ids[q]) < g.k))
                point = {
                    "ladder_index": li,
                    "knobs": knobs,
                    "recall": rec["recall"],
                    "recall_strict": rec["recall_strict"],
                    "tail": rec["tail"],
                    "short_results": short,
                    "qps": best["qps"],
                    "latency_ms": best["_stats"],
                    "queries": best["queries"],
                    "duration": best["duration"],
                    "passes": [{k: v for k, v in p.items() if k != "_stats"} for p in passes],
                }
                group_rec["points"].append(point)
                log.info("[%s %s] %s recall=%.4f qps=%.1f p50=%.2fms p99=%.2fms (%d queries, %d passes)",
                         view, g.key, knobs or "exact", rec["recall"] or 0.0, best["qps"] or 0.0, best["p50"] or 0.0, best["p99"] or 0.0, best["queries"], len(passes))
                rf.upsert_group(group_rec)
            group_rec["memory_peak"] = self.p.memory_peak(self.env)
            rf.upsert_group(group_rec)
        except PlanCheckError as e:
            log.error("[%s %s] plan check failed: %s", view, g.key, e)
            rf.upsert_group({**base, "status": "error", "reason": f"plan check failed: {e}", "plan": group_rec.get("plan"), "block": block})
        except Exception as e:  # noqa: BLE001
            log.exception("[%s %s] failed", view, g.key)
            rf.upsert_group({**base, "status": "error", "reason": str(e)[:2000], "points": group_rec.get("points", []), "plan": group_rec.get("plan")})
        finally:
            pool.close()

    # ----------------------------------------------------------------- run
    def run(self) -> Path:
        rf = ResultFile(self.p.result_path(self.dataset, self.opts.label), self.header())
        if self.opts.index:
            self.do_load(rf)
        else:
            self.apply_load_record(rf)
        startups: list[float] = []
        mem_sections: dict[str, int] = {}
        for view in self.opts.views:
            for g in self.selected_groups():
                self.run_group(g, view, rf, startups)
                grp = rf.find_group(g.key, view)
                if grp and grp.get("memory_peak"):
                    sec = "unfiltered" if g.filter == "none" else "filtered"
                    mem_sections[sec] = max(mem_sections.get(sec, 0), int(grp["memory_peak"]))
                rf.set(startup=metrics.stats(startups), memory_peak={**(rf.obj.get("memory_peak") or {}), **mem_sections})
        self.p.stop(self.env)
        path = rf.finish()
        log.info("results written to %s", path)
        return path
