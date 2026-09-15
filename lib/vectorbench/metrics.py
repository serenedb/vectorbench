"""Recall, tail and latency statistics (docs/contracts.md sections 3.5 of DESIGN and 8 of contracts)."""

from __future__ import annotations

import numpy as np

TIE_EPS = 1e-6
TAIL_THRESHOLD = 0.5


def stats(values: np.ndarray | list[float]) -> dict[str, float | int]:
    """n, min, avg, p50, p95, p99, max. Values are whatever unit the caller uses (we use ms)."""
    v = np.asarray(values, dtype=np.float64)
    if v.size == 0:
        return {"n": 0, "min": None, "avg": None, "p50": None, "p95": None, "p99": None, "max": None}
    p50, p95, p99 = np.percentile(v, [50, 95, 99])
    return {
        "n": int(v.size),
        "min": float(v.min()),
        "avg": float(v.mean()),
        "p50": float(p50),
        "p95": float(p95),
        "p99": float(p99),
        "max": float(v.max()),
    }


def pad_ids(results: list[list[int]], k: int) -> np.ndarray:
    """[nq, k] int64 with -1 padding; extra ids beyond k are dropped (rank order preserved)."""
    out = np.full((len(results), k), -1, dtype=np.int64)
    for i, ids in enumerate(results):
        n = min(len(ids), k)
        if n:
            out[i, :n] = np.asarray(ids[:n], dtype=np.int64)
    return out


def recall(returned: np.ndarray, gt_ids: np.ndarray, gt_dists: np.ndarray, k: int) -> dict[str, object]:
    """Tie-aware and strict recall@k plus tail, from padded returned ids [nq, k].

    Tie-aware: a returned id counts if it is among the ground-truth ids whose distance is at most the
    k-th ground-truth distance plus TIE_EPS (big-ann's definition). Strict: it must be in the top-k ids.
    Denominator is k for both. Invalid ground-truth slots (id < 0 or non-finite distance) never count."""
    nq = returned.shape[0]
    kk = min(k, gt_ids.shape[1])
    tie = np.empty(nq, dtype=np.float64)
    strict = np.empty(nq, dtype=np.float64)
    for i in range(nq):
        g_ids = gt_ids[i]
        g_d = gt_dists[i]
        valid = (g_ids >= 0) & np.isfinite(g_d)
        top = g_ids[:kk][valid[:kk]]
        if top.size == 0:
            tie[i] = 0.0
            strict[i] = 0.0
            continue
        thresh = g_d[:kk][valid[:kk]].max() + TIE_EPS
        tie_set = g_ids[valid & (g_d <= thresh)]
        r = returned[i]
        r = r[r >= 0]
        strict[i] = np.isin(r, top).sum() / k
        tie[i] = np.isin(r, tie_set).sum() / k
    return {
        "recall": float(tie.mean()) if nq else None,
        "recall_strict": float(strict.mean()) if nq else None,
        "tail": float((tie < TAIL_THRESHOLD).mean()) if nq else None,
        "per_query": tie,
    }
