#!/usr/bin/env python3
"""Smoke test of the Qdrant HNSW participant against a running Qdrant (README, "Smoke test").

No driver package needed. It builds a tiny dataset in the shape of docs/contracts.md section 2 -- random
vectors, attribute columns from a local copy of the splitmix64 rule, clusters from random centroids --
writes it as two base shards into a temporary directory, loads it with load.py's own functions
(collection, payload indexes, upload workers, index, settle), then drives client.py through every group
key of queries.json and checks per query: exactly k ids, all distinct and known, every one satisfying the
predicate evaluated in numpy; exact groups must return the true top-k (tie-aware). The recall of the
approximate groups is printed and must stay above a loose floor.

    .venv/bin/python qdrant-hnsw/smoke_test.py --port 6434 --grpc-port 6433 [--metric ip|l2|both]

40,000 rows rather than a few thousand so that the 0.1 % case still has more than k=10 matching rows."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import tempfile
import time
import zlib
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import load as loader  # noqa: E402
from client import Client  # noqa: E402

GOLDEN = 0x9E3779B97F4A7C15
NUM_RANGE = 1_000_000
CARDINALITY = {"cat10": 10, "cat100": 100, "cat1000": 1000}
LANGS = ["en", "de", "fr"]
CENTROIDS = 8
CASES: dict[str, dict[str, Any]] = {  # the filter cases of datasets/*.yml
    "none": {},
    "eq-10": {"op": "eq", "field": "cat10"},
    "eq-1": {"op": "eq", "field": "cat100"},
    "eq-0.1": {"op": "eq", "field": "cat1000"},
    "range-10": {"op": "range", "field": "num", "fraction": 0.10},
    "range-1": {"op": "range", "field": "num", "fraction": 0.01},
    "and-1": {"op": "and", "terms": [{"op": "eq", "field": "cat10"}, {"op": "range", "field": "num", "fraction": 0.10}]},
    "corr": {"op": "eq", "field": "cluster", "value": "query_cluster"},
    "xcorr": {"op": "eq", "field": "cluster", "value": "far_cluster"},
    "lang": {"op": "eq", "field": "lang", "value": "query_lang"},
    "xlang": {"op": "eq", "field": "lang", "value": "other_lang"},
}
KS = {"none/*": [10, 100, 1000], "eq-10/*": [10, 100]}  # every other group runs at k=10
RECALL_FLOOR = 0.8
KNOB_RE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")


# ------------------------------------------------------------------ contracts section 2 and 3, locally
def splitmix64(x: np.ndarray) -> np.ndarray:
    with np.errstate(over="ignore"):
        z = np.asarray(x, dtype=np.uint64) + np.uint64(GOLDEN)
        z = (z ^ (z >> np.uint64(30))) * np.uint64(0xBF58476D1CE4E5B9)
        z = (z ^ (z >> np.uint64(27))) * np.uint64(0x94D049BB133111EB)
        return z ^ (z >> np.uint64(31))


def h(ids: np.ndarray, seed: int) -> np.ndarray:
    with np.errstate(over="ignore"):
        return splitmix64(splitmix64(np.asarray(ids, dtype=np.uint64)) ^ np.uint64((seed * GOLDEN) & 0xFFFFFFFFFFFFFFFF))


def case_seed(name: str) -> int:
    return int(h(np.array([zlib.crc32(name.encode())], dtype=np.uint64), 0)[0])


def nearest(x: np.ndarray, centroids: np.ndarray, farthest: bool = False) -> np.ndarray:
    d = (centroids**2).sum(1)[None, :] - 2.0 * (x @ centroids.T)
    return (np.argmax if farthest else np.argmin)(d, axis=1).astype(np.int16)


@dataclass
class Data:
    ids: np.ndarray
    emb: np.ndarray
    cols: dict[str, np.ndarray]
    queries: np.ndarray
    qcluster: np.ndarray
    qfar: np.ndarray
    qlang: np.ndarray


def make_data(rows: int, dims: int, nq: int, rng: np.random.Generator) -> Data:
    ids = np.arange(rows, dtype=np.int64)
    emb = rng.standard_normal((rows, dims), dtype=np.float32)
    centroids = rng.standard_normal((CENTROIDS, dims), dtype=np.float32)
    cols = {
        "cat10": (h(ids, 1) % np.uint64(10)).astype(np.int16),
        "cat100": (h(ids, 2) % np.uint64(100)).astype(np.int16),
        "cat1000": (h(ids, 3) % np.uint64(1000)).astype(np.int16),
        "num": (h(ids, 4) % np.uint64(NUM_RANGE)).astype(np.int32),
        "ts": np.datetime64("2020-01-01T00:00:00", "s") + ids.astype("timedelta64[s]"),
        "cluster": nearest(emb, centroids),
        "lang": np.array(LANGS, dtype=object)[(h(ids, 5) % np.uint64(len(LANGS))).astype(np.int64)],
        "title": np.array([f"row {i}" for i in ids], dtype=object),
    }
    queries = rng.standard_normal((nq, dims), dtype=np.float32)
    qids = np.arange(nq)
    qlang = np.array(LANGS, dtype=object)[(h(qids, 6) % np.uint64(len(LANGS))).astype(np.int64)]
    return Data(ids, emb, cols, queries, nearest(queries, centroids), nearest(queries, centroids, farthest=True), qlang)


def write_shards(data: Data, dataset_dir: Path, dims: int, shard_rows: int) -> None:
    base = dataset_dir / "base"
    base.mkdir(parents=True, exist_ok=True)
    for s, start in enumerate(range(0, len(data.ids), shard_rows)):
        sl = slice(start, start + shard_rows)
        emb = pa.FixedSizeListArray.from_arrays(pa.array(data.emb[sl].ravel()), dims)
        table = pa.table({"id": data.ids[sl], "emb": emb, **{c: pa.array(data.cols[c][sl]) for c in loader.PAYLOAD_COLUMNS}})
        pq.write_table(table, base / f"part_{s:05d}.parquet")


def query_args(case: str, spec: dict[str, Any], qi: int, data: Data) -> dict[str, Any]:
    """The named parameters of one query for one case (contracts section 3): only the keys the case uses."""
    op = spec.get("op")
    if op is None:
        return {}
    seed = case_seed(case)
    qid = np.array([qi])

    def eq(term: dict[str, Any], s: int) -> dict[str, Any]:
        f = term["field"]
        if f == "cluster":
            return {"v": int((data.qcluster if term["value"] == "query_cluster" else data.qfar)[qi])}
        if f == "lang":
            l = str(data.qlang[qi])
            return {"s": l if term["value"] == "query_lang" else LANGS[(LANGS.index(l) + 1) % len(LANGS)]}
        return {"v": int(h(qid, s)[0] % np.uint64(CARDINALITY[f]))}

    def rng_(term: dict[str, Any], s: int) -> dict[str, Any]:
        w = int(round(term["fraction"] * NUM_RANGE))
        lo = int(h(qid, s)[0] % np.uint64(NUM_RANGE - w + 1))
        return {"lo": lo, "hi": lo + w - 1}

    if op == "eq":
        return eq(spec, seed)
    if op == "range":
        return rng_(spec, seed)
    return {**eq(spec["terms"][0], seed), **rng_(spec["terms"][1], seed + 1)}


def predicate_mask(spec: dict[str, Any], cols: dict[str, np.ndarray], a: dict[str, Any]) -> np.ndarray:
    op = spec.get("op")
    if op is None:
        return np.ones(len(cols["num"]), dtype=bool)
    if op == "eq":
        f = spec["field"]
        return cols[f] == (a["s"] if f == "lang" else a["v"])
    if op == "range":
        return (cols["num"] >= a["lo"]) & (cols["num"] <= a["hi"])
    return (cols["cat10"] == a["v"]) & (cols["num"] >= a["lo"]) & (cols["num"] <= a["hi"])


# ------------------------------------------------------------------------------------------ the test
def scores(data: Data, qi: int, metric: str) -> np.ndarray:
    """Higher is better for both metrics."""
    q = data.queries[qi]
    return data.emb @ q if metric == "ip" else -((data.emb - q) ** 2).sum(axis=1)


def check_group(client: Client, key: str, block: dict[str, Any], k: int, data: Data, metric: str, hnsw_ef: int) -> tuple[bool, str]:
    exact = key.startswith("exact/")
    case = key.split("/")[-2]
    spec = CASES[case]
    text = KNOB_RE.sub(lambda m: str({"hnsw_ef": hnsw_ef}[m.group(1)]), json.dumps(block))  # as the driver does
    handle = client.prepare_group(text)
    problems: list[str] = []
    recall_sum = 0.0
    search_s = 0.0
    for qi in range(len(data.queries)):
        args = query_args(case, spec, qi, data)
        mask = predicate_mask(spec, data.cols, args)
        if mask.sum() < k:
            raise SystemExit(f"{key} k={k}: only {int(mask.sum())} rows match query {qi}; raise --rows")
        sc = np.where(mask, scores(data, qi, metric), -np.inf)
        kth = np.partition(sc, len(sc) - k)[len(sc) - k]
        t0 = time.perf_counter()
        ids = client.search(handle, data.queries[qi], k, args)
        search_s += time.perf_counter() - t0
        if len(ids) != k or len(set(ids)) != k:
            problems.append(f"q{qi}: {len(ids)} ids, {len(set(ids))} distinct")
            continue
        arr = np.asarray(ids, dtype=np.int64)
        if arr.min() < 0 or arr.max() >= len(data.ids):
            problems.append(f"q{qi}: unknown id")
            continue
        if not mask[arr].all():
            problems.append(f"q{qi}: {int((~mask[arr]).sum())} ids violate the predicate")
        hits = int((sc[arr] >= kth - 1e-4 * abs(kth)).sum())  # tie-aware: the true k-th score, with slack
        recall_sum += hits / k
        if exact and hits != k:
            problems.append(f"q{qi}: exact search returned {hits}/{k} of the true top-k")
    recall = recall_sum / len(data.queries)
    ms = search_s / len(data.queries) * 1000
    if not exact and recall < RECALL_FLOOR:
        problems.append(f"recall {recall:.3f} below {RECALL_FLOOR}")
    verdict = "ok" if not problems else "FAIL " + "; ".join(problems[:3])
    return not problems, f"{key:<16} k={k:<5} recall={recall:.3f} {ms:6.2f} ms/query  {verdict}"


def run(metric: str, args: argparse.Namespace, data: Data, dataset_dir: Path) -> bool:
    target = loader.Target("127.0.0.1", args.port, args.grpc_port, f"{args.collection}_{metric}")
    cfg = loader.IndexConfig(m=16, ef_construct=128, quant="none", on_disk_vectors=False, on_disk_hnsw=False,
                             segments=8, full_scan_threshold_kb=10, max_segment_size_kb=None)
    client = target.connect()
    loader.wait_ready(client)
    t0 = time.perf_counter()
    loader.create_collection(client, target, args.dims, metric, cfg)
    t1 = time.perf_counter()
    uploaded = loader.upload(target, args.dims, loader.base_shards(dataset_dir), workers=2)
    assert uploaded == args.rows, uploaded
    t2 = time.perf_counter()
    loader.drain(client, target, args.rows)
    t3 = time.perf_counter()
    info = loader.build_index(client, target, args.rows)
    print(f"[{metric}] loaded {args.rows} rows: create {t1 - t0:.1f}s, upload {t2 - t1:.1f}s, drain {t3 - t2:.1f}s, "
          f"index+settle {time.perf_counter() - t3:.1f}s, {info.segments_count} segments, {info.indexed_vectors_count} indexed vectors")
    client.close()

    blocks = json.loads((HERE / "queries.json").read_text())
    conn = {"host": "127.0.0.1", "port": args.port, "grpc_port": args.grpc_port, "prefer_grpc": True,
            "collection": target.collection, "timeout": 600, "metric": metric, "dims": args.dims, "dataset": "smoke"}
    c = Client(conn)
    c.connect()
    ok = True
    try:
        for key, block in blocks.items():
            for k in KS.get(key, [10]):
                good, line = check_group(c, key, block, k, data, metric, args.hnsw_ef)
                ok &= good
                print(f"[{metric}] {line}")
    finally:
        c.close()
        if not args.keep:
            cl = target.connect()
            cl.delete_collection(target.collection)
            cl.close()
    return ok


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=6533, help="REST port of the running Qdrant")
    ap.add_argument("--grpc-port", type=int, default=6534, help="gRPC port of the running Qdrant")
    ap.add_argument("--metric", choices=["ip", "l2", "both"], default="both")
    ap.add_argument("--rows", type=int, default=40_000)
    ap.add_argument("--dims", type=int, default=32)
    ap.add_argument("--queries", type=int, default=20)
    ap.add_argument("--hnsw-ef", type=int, default=64, help="the ladder point substituted for {hnsw_ef}")
    ap.add_argument("--collection", default="vb_smoke", help="collection name prefix (suffixed by the metric)")
    ap.add_argument("--data-dir", type=Path, default=None, help="write the dataset here instead of a temporary directory")
    ap.add_argument("--keep", action="store_true", help="keep the collections and the dataset directory")
    args = ap.parse_args()

    data = make_data(args.rows, args.dims, args.queries, np.random.default_rng(7))
    tmp = args.data_dir or Path(tempfile.mkdtemp(prefix="vb-qdrant-smoke-"))
    write_shards(data, tmp, args.dims, shard_rows=(args.rows + 1) // 2)
    print(f"dataset: {args.rows} rows x {args.dims} dims in {tmp} (2 shards)")
    ok = True
    try:
        for metric in (["ip", "l2"] if args.metric == "both" else [args.metric]):
            ok &= run(metric, args, data, tmp)
    finally:
        if not args.keep and args.data_dir is None:
            shutil.rmtree(tmp, ignore_errors=True)
    print("SMOKE TEST PASSED" if ok else "SMOKE TEST FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
