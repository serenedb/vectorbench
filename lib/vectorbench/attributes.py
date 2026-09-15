"""Synthetic attribute columns, per-query filter arguments and predicate evaluation
(docs/contracts.md sections 2 and 3).

Everything here is a pure function of row ids, query ids and the family definition, so every engine,
every size and every run sees identical values.
"""

from __future__ import annotations

import zlib
from typing import Any

import numpy as np

MASK64 = np.uint64(0xFFFFFFFFFFFFFFFF)
GOLDEN = 0x9E3779B97F4A7C15
CARDINALITY = {"cat10": 10, "cat100": 100, "cat1000": 1000}
NUM_RANGE = 1_000_000
TS_EPOCH = np.datetime64("2020-01-01T00:00:00", "s")
ARG_COLUMNS = ("v", "lo", "hi", "v2", "s")


def _u64(x: np.ndarray) -> np.ndarray:
    return np.asarray(x).astype(np.uint64, copy=False)


def splitmix64(x: np.ndarray) -> np.ndarray:
    """SplitMix64 finalizer, vectorized, wrap-around uint64 arithmetic."""
    with np.errstate(over="ignore"):
        z = _u64(x) + np.uint64(GOLDEN)
        z = (z ^ (z >> np.uint64(30))) * np.uint64(0xBF58476D1CE4E5B9)
        z = (z ^ (z >> np.uint64(27))) * np.uint64(0x94D049BB133111EB)
        return z ^ (z >> np.uint64(31))


def h(ids: np.ndarray, seed: int) -> np.ndarray:
    """h(id, seed) = splitmix64(splitmix64(id) XOR (seed * GOLDEN))."""
    with np.errstate(over="ignore"):
        mix = np.uint64((int(seed) * GOLDEN) & 0xFFFFFFFFFFFFFFFF)
        return splitmix64(splitmix64(_u64(ids)) ^ mix)


def case_seed(case_name: str) -> int:
    return int(h(np.array([zlib.crc32(case_name.encode("utf-8"))], dtype=np.uint64), 0)[0])


def synthetic_columns(ids: np.ndarray) -> dict[str, np.ndarray]:
    ids = np.asarray(ids, dtype=np.int64)
    return {
        "cat10": (h(ids, 1) % np.uint64(10)).astype(np.int16),
        "cat100": (h(ids, 2) % np.uint64(100)).astype(np.int16),
        "cat1000": (h(ids, 3) % np.uint64(1000)).astype(np.int16),
        "num": (h(ids, 4) % np.uint64(NUM_RANGE)).astype(np.int32),
        "ts": TS_EPOCH + ids.astype("timedelta64[s]"),
    }


def assign_clusters(vectors: np.ndarray, centroids: np.ndarray, block: int = 65536) -> np.ndarray:
    """Nearest centroid by squared l2, in blocks."""
    out = np.empty(len(vectors), dtype=np.int16)
    cn = (centroids.astype(np.float32) ** 2).sum(axis=1)
    for s in range(0, len(vectors), block):
        x = np.ascontiguousarray(vectors[s : s + block], dtype=np.float32)
        d = cn[None, :] - 2.0 * (x @ centroids.T.astype(np.float32))
        out[s : s + block] = np.argmin(d, axis=1).astype(np.int16)
    return out


def far_clusters(vectors: np.ndarray, centroids: np.ndarray, block: int = 65536) -> np.ndarray:
    """Index of the centroid farthest (squared l2) from each vector."""
    out = np.empty(len(vectors), dtype=np.int16)
    cn = (centroids.astype(np.float32) ** 2).sum(axis=1)
    for s in range(0, len(vectors), block):
        x = np.ascontiguousarray(vectors[s : s + block], dtype=np.float32)
        d = cn[None, :] - 2.0 * (x @ centroids.T.astype(np.float32))
        out[s : s + block] = np.argmax(d, axis=1).astype(np.int16)
    return out


def _empty_args(n: int) -> dict[str, np.ndarray]:
    return {
        "v": np.full(n, -1, dtype=np.int64),
        "lo": np.full(n, -1, dtype=np.int64),
        "hi": np.full(n, -1, dtype=np.int64),
        "v2": np.full(n, -1, dtype=np.int64),
        "s": np.array([""] * n, dtype=object),
    }


def _eq_values(spec: dict[str, Any], qids: np.ndarray, seed: int, qinfo: dict[str, Any]) -> np.ndarray | None:
    """Integer argument for an eq term, or None when the term is on `lang` (string, see _lang_values)."""
    field = spec["field"]
    value = spec.get("value")
    if field == "cluster":
        if value == "query_cluster":
            return np.asarray(qinfo["query_cluster"], dtype=np.int64)[qids]
        if value == "far_cluster":
            return np.asarray(qinfo["far_cluster"], dtype=np.int64)[qids]
        raise ValueError(f"eq on cluster needs value query_cluster or far_cluster, got {value!r}")
    if field == "lang":
        return None
    if field not in CARDINALITY:
        raise ValueError(f"eq on unsupported field {field!r}")
    return (h(qids, seed) % np.uint64(CARDINALITY[field])).astype(np.int64)


def _lang_values(spec: dict[str, Any], qids: np.ndarray, qinfo: dict[str, Any]) -> np.ndarray:
    langs = list(qinfo["langs"])
    qlang = np.asarray(qinfo["query_lang"], dtype=object)[qids]
    value = spec.get("value")
    if value == "query_lang":
        return qlang
    if value == "other_lang":
        idx = {l: i for i, l in enumerate(langs)}
        return np.array([langs[(idx[l] + 1) % len(langs)] for l in qlang], dtype=object)
    raise ValueError(f"eq on lang needs value query_lang or other_lang, got {value!r}")


def _range_values(spec: dict[str, Any], qids: np.ndarray, seed: int) -> tuple[np.ndarray, np.ndarray]:
    if spec["field"] != "num":
        raise ValueError(f"range on unsupported field {spec['field']!r}")
    w = int(round(float(spec["fraction"]) * NUM_RANGE))
    lo = (h(qids, seed) % np.uint64(NUM_RANGE - w + 1)).astype(np.int64)
    return lo, lo + w - 1


def query_args(case_name: str, spec: dict[str, Any], qids: np.ndarray, qinfo: dict[str, Any]) -> dict[str, np.ndarray]:
    """Per-query arguments for one filter case (contracts section 3).

    qinfo carries, indexed by qid: query_cluster, far_cluster, query_lang, and the family's langs."""
    qids = np.asarray(qids, dtype=np.int64)
    out = _empty_args(len(qids))
    op = spec.get("op")
    if not spec or op is None:
        return out
    seed = case_seed(case_name)
    if op == "eq":
        if spec["field"] == "lang":
            out["s"] = _lang_values(spec, qids, qinfo)
        else:
            out["v"] = _eq_values(spec, qids, seed, qinfo)
    elif op == "range":
        out["lo"], out["hi"] = _range_values(spec, qids, seed)
    elif op == "and":
        terms = spec["terms"]
        if len(terms) != 2 or terms[0].get("op") != "eq" or terms[1].get("op") != "range":
            raise ValueError(f"case {case_name}: `and` must be [eq-term, range-term]")
        out["v"] = _eq_values(terms[0], qids, seed, qinfo)
        out["lo"], out["hi"] = _range_values(terms[1], qids, seed + 1)
    else:
        raise ValueError(f"case {case_name}: unknown op {op!r}")
    return out


def args_for_query(args: dict[str, np.ndarray], qi: int, spec: dict[str, Any]) -> dict[str, Any]:
    """The named parameters a statement receives for query index `qi`: only the keys the case uses."""
    op = spec.get("op")
    if op is None:
        return {}
    if op == "eq":
        if spec["field"] == "lang":
            return {"s": str(args["s"][qi])}
        return {"v": int(args["v"][qi])}
    if op == "range":
        return {"lo": int(args["lo"][qi]), "hi": int(args["hi"][qi])}
    if op == "and":
        return {"v": int(args["v"][qi]), "lo": int(args["lo"][qi]), "hi": int(args["hi"][qi])}
    raise ValueError(op)


def used_arg_keys(spec: dict[str, Any]) -> tuple[str, ...]:
    op = spec.get("op")
    if op is None:
        return ()
    if op == "eq":
        return ("s",) if spec["field"] == "lang" else ("v",)
    if op == "range":
        return ("lo", "hi")
    if op == "and":
        return ("v", "lo", "hi")
    raise ValueError(op)


def predicate_mask(spec: dict[str, Any], cols: dict[str, np.ndarray], args: dict[str, np.ndarray], qsel: slice | np.ndarray | None = None) -> np.ndarray:
    """Boolean mask [nq_sel, rows] telling which rows satisfy the case for each selected query.

    `cols` holds the attribute columns of a block of rows; `args` the per-query arguments for the
    whole query set; `qsel` selects queries (default all)."""
    op = spec.get("op")
    sel = slice(None) if qsel is None else qsel
    if op is None:
        nq = len(args["v"][sel])
        return np.ones((nq, len(next(iter(cols.values())))), dtype=bool)
    if op == "eq":
        field = spec["field"]
        if field == "lang":
            s = np.asarray(args["s"][sel], dtype=object)
            col = np.asarray(cols["lang"], dtype=object)
            return col[None, :] == s[:, None]
        v = np.asarray(args["v"][sel], dtype=np.int64)
        return np.asarray(cols[field], dtype=np.int64)[None, :] == v[:, None]
    if op == "range":
        num = np.asarray(cols["num"], dtype=np.int64)[None, :]
        lo = np.asarray(args["lo"][sel], dtype=np.int64)[:, None]
        hi = np.asarray(args["hi"][sel], dtype=np.int64)[:, None]
        return (num >= lo) & (num <= hi)
    if op == "and":
        t0, t1 = spec["terms"]
        v = np.asarray(args["v"][sel], dtype=np.int64)[:, None]
        m = np.asarray(cols[t0["field"]], dtype=np.int64)[None, :] == v
        num = np.asarray(cols["num"], dtype=np.int64)[None, :]
        lo = np.asarray(args["lo"][sel], dtype=np.int64)[:, None]
        hi = np.asarray(args["hi"][sel], dtype=np.int64)[:, None]
        return m & (num >= lo) & (num <= hi)
    raise ValueError(op)


def row_satisfies(spec: dict[str, Any], row: dict[str, Any], qargs: dict[str, Any]) -> bool:
    """Scalar predicate check for one returned row against one query's arguments (used by `check`)."""
    op = spec.get("op")
    if op is None:
        return True
    if op == "eq":
        if spec["field"] == "lang":
            return str(row["lang"]) == qargs["s"]
        return int(row[spec["field"]]) == qargs["v"]
    if op == "range":
        return qargs["lo"] <= int(row["num"]) <= qargs["hi"]
    if op == "and":
        t0, _ = spec["terms"]
        return int(row[t0["field"]]) == qargs["v"] and qargs["lo"] <= int(row["num"]) <= qargs["hi"]
    raise ValueError(op)
