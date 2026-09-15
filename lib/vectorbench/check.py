"""`vectorbench check`: on a small dataset size, verify for every supported group that the engine returns
exactly k ids, that every returned id satisfies the predicate, and that exact groups reach recall 1.000."""

from __future__ import annotations

import logging
from pathlib import Path

import numpy as np
import pyarrow.parquet as pq

from . import attributes, metrics
from .engine import Participant
from .families import Family
from .prepare import dataset_dir, load_manifest
from .queries import ladder_for, ladder_points, load_blocks, resolve_block, resolve_settings, substitute_index, substitute_knobs
from .runner import GroundTruth, check_plan
from .workers import PassSpec, WorkerPool

log = logging.getLogger(__name__)


def _base_attributes(dsdir: Path, manifest: dict) -> dict[str, np.ndarray]:
    """id -> attribute columns for the whole (small) base."""
    cols = {"cat10": [], "cat100": [], "cat1000": [], "num": [], "cluster": [], "lang": []}
    ids = []
    for sh in manifest["shards"]:
        t = pq.read_table(dsdir / sh["path"], columns=["id", *cols])
        ids.append(t.column("id").to_numpy())
        for c in cols:
            col = t.column(c)
            cols[c].append(np.asarray(col.to_pylist(), dtype=object) if c == "lang" else col.to_numpy())
    out = {c: np.concatenate(v) for c, v in cols.items()}
    out["id"] = np.concatenate(ids)
    order = np.argsort(out["id"])
    return {c: v[order] for c, v in out.items()}


def run_check(p: Participant, family: Family, size: str, data_dir: Path, queries: int = 200, cpuset: str | None = None, memory: str | None = None) -> int:
    manifest = load_manifest(family, size, data_dir)
    if manifest["rows"] > 2_000_000:
        raise SystemExit("check is meant for the 100k or 1m size")
    dsdir = dataset_dir(family, size, data_dir)
    env = p.env(family, size, data_dir, cpuset, memory, resolve_settings(p.settings, family, size)["index"])
    blocks = load_blocks(p.query_file())
    gt = GroundTruth(dsdir, family)
    base = _base_attributes(dsdir, manifest)
    nq = min(queries, int(manifest["nq"]))
    failures = 0
    p.stop(env)
    startup = p.start(env)
    log.info("engine ready in %.2fs", startup)
    pool = WorkerPool(1, p.dir / "client.py", p.connection(family, family.dataset_id(size), resolve_settings(p.settings, family, size)["index"]), dsdir / "queries.parquet", family.dims, nq_limit=nq)
    try:
        for g in family.groups():
            block = resolve_block(blocks, g)
            if block is None:
                log.info("%-22s unsupported (no block)", g.key)
                continue
            spec = family.case(g.filter)
            args = gt.per_query_args(g.filter, nq)
            pool.set_group(args)
            st = resolve_settings(p.settings, family, size, g)
            block = substitute_index(block, {**st["index"], "dims": family.dims, "metric": family.metric})
            knobs = {} if g.exact else ladder_points(ladder_for(block, st["ladder"]))[-1]  # the most thorough point
            pool.prepare(substitute_knobs(block, knobs) if knobs else block)
            plan = pool.explain(g.k)
            plan_bad = check_plan(plan, g, p.settings.get("plan_rules") or {}) if plan is not None else None
            res = pool.run_pass(PassSpec(deadline_s=600, min_queries=nq, collect_ids=True, k=g.k))
            ids = res["ids"]
            qis = sorted(q for q in ids if q < nq)
            short = sum(1 for q in qis if len(ids[q]) != g.k)
            bad_pred = 0
            unknown = 0
            for q in qis:
                qa = args[q]
                for rid in ids[q]:
                    pos = np.searchsorted(base["id"], rid)
                    if pos >= len(base["id"]) or base["id"][pos] != rid:
                        unknown += 1
                        continue
                    row = {c: base[c][pos] for c in ("cat10", "cat100", "cat1000", "num", "cluster", "lang")}
                    if not attributes.row_satisfies(spec, row, qa):
                        bad_pred += 1
            g_gt = gt.case(g.filter)
            returned = metrics.pad_ids([ids[q] for q in qis], g.k)
            rec = metrics.recall(returned, g_gt["ids"][qis], g_gt["dists"][qis], g.k)
            ok = short == 0 and bad_pred == 0 and unknown == 0 and plan_bad is None and (not g.exact or rec["recall"] >= 0.9999)
            failures += 0 if ok else 1
            log.info("%-22s %s recall=%.4f short=%d bad_predicate=%d unknown_ids=%d p50=%.2fms plan=%s",
                     g.key, "OK  " if ok else "FAIL", rec["recall"] or 0, short, bad_pred, unknown, metrics.stats(res["latencies_ms"])["p50"] or 0,
                     plan_bad or ("ok" if plan is not None else "n/a"))
    finally:
        pool.close()
        p.stop(env)
    if failures:
        log.error("%d group(s) failed", failures)
        return 1
    log.info("all groups passed")
    return 0
