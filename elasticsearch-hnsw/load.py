"""Ingest a prepared dataset into Elasticsearch and wait for the index to settle.

Reads the shards of $VECTORBENCH_DATASET_DIR/base, bulk-indexes them, then refreshes and waits for
merges to stop moving. Index parameters come from VB_INDEX_<KEY> (settings.yml section 6): type, m,
ef_construction, shards.

Prints the two load tags of docs/contracts.md section 4 on stdout."""

from __future__ import annotations

import datetime as dt
import http.client
import json
import os
import sys
import time
from dataclasses import asdict, dataclass

import numpy as np
import pyarrow.parquet as pq

HOST = os.environ.get("VB_HOST", "127.0.0.1")
PORT = int(os.environ.get("VB_PORT", "9200"))
INDEX = os.environ.get("VB_INDEX_NAME", "items")
DATASET_DIR = os.environ["VECTORBENCH_DATASET_DIR"]
DIMS = int(os.environ["VECTORBENCH_DIMS"])
METRIC = os.environ.get("VECTORBENCH_METRIC", "ip").lower()
BULK_DOCS = int(os.environ.get("VB_BULK_DOCS", "500"))
SETTLE_POLLS = 4  # consecutive 5-second polls with an unchanged segment count


# Qdrant keeps every attribute in its payload and SereneDB keeps every column in the table, so these
# two engines keep them too, or load time and index size would not be comparable. `ts` and `title`
# are not used by any filter case, so they are stored without an inverted index: declared with
# indexing off and carried in `_source`, which is the same shape as an unindexed Qdrant payload.
# `_source` excludes the vector, which Lucene already stores in its own file and Qdrant never
# duplicates into the payload.
def json_value(v: Any) -> Any:
    """A parquet cell as JSON. Timestamps travel as epoch milliseconds."""
    if isinstance(v, np.datetime64):
        return int(v.astype("datetime64[ms]").astype("int64"))
    if isinstance(v, dt.datetime):
        return int(v.timestamp() * 1000)
    return v.item() if hasattr(v, "item") else v


# Bulk bodies are mostly vectors, and at 1024 dimensions the standard library spends longer turning
# a document into text than Elasticsearch spends indexing it: sift's 128 dimensions took 274 seconds
# for a million rows, and the payload per document is eight times larger on wiki. orjson serialises a
# numpy array without converting it to a Python list first. It is optional, so the participant still
# runs without it.
try:
    import orjson

    _NUMPY = orjson.OPT_SERIALIZE_NUMPY

    def dumps(obj: Any) -> bytes:
        return orjson.dumps(obj, option=_NUMPY)
except ImportError:  # pragma: no cover - exercised only where orjson is absent
    def dumps(obj: Any) -> bytes:
        # The vector arrives as a numpy array either way, so the fallback has to widen it too.
        return json.dumps(obj, separators=(",", ":"),
                          default=lambda o: o.tolist()).encode()


def log(msg: str) -> None:
    print(msg, flush=True)


def env_int(name: str, default: int) -> int:
    v = os.environ.get(name)
    return int(v) if v not in (None, "") else default


def env_str(name: str, default: str) -> str:
    v = os.environ.get(name)
    return v if v not in (None, "") else default


@dataclass
class IndexConfig:
    type: str
    m: int
    ef_construction: int
    shards: int
    segments: int

    @staticmethod
    def from_env() -> "IndexConfig":
        shards = env_int("VB_INDEX_SHARDS", 1)
        return IndexConfig(
            type=env_str("VB_INDEX_TYPE", "int8_hnsw").lower(),
            m=env_int("VB_INDEX_M", 16),
            ef_construction=env_int("VB_INDEX_EF_CONSTRUCTION", 128),
            shards=shards,
            segments=env_int("VB_INDEX_SEGMENTS", shards),
        )

    def per_shard(self) -> int:
        return max(1, self.segments // self.shards)


class Es:
    """The bits of the REST API this loader needs, over one kept-alive connection."""

    def __init__(self) -> None:
        self.conn = http.client.HTTPConnection(HOST, PORT, timeout=1200)

    def request(self, method: str, path: str, body: bytes | None = None,
                content_type: str = "application/json", allow_fail: bool = False):
        headers = {"Content-Type": content_type}
        if body is not None:
            headers["Content-Length"] = str(len(body))
        self.conn.request(method, path, body, headers)
        resp = self.conn.getresponse()
        data = resp.read()
        if resp.status >= 300:
            text = data[:600].decode(errors="replace")
            if allow_fail:
                return {"__error__": text, "__status__": resp.status}
            raise SystemExit(f"{method} {path} -> {resp.status}: {text}")
        return json.loads(data) if data else {}

    def json(self, method: str, path: str, body: dict | None = None, allow_fail: bool = False):
        payload = json.dumps(body).encode() if body is not None else None
        return self.request(method, path, payload, allow_fail=allow_fail)


def similarity() -> str:
    # dot_product demands unit-length vectors; max_inner_product does not, and the prepared corpora
    # are not normalised for every family.
    return "l2_norm" if METRIC == "l2" else "max_inner_product"


def create_index(es: Es, cfg: IndexConfig) -> None:
    es.json("DELETE", f"/{INDEX}", allow_fail=True)
    options: dict[str, object] = {"type": cfg.type, "m": cfg.m, "ef_construction": cfg.ef_construction}
    properties = {
        "emb": {"type": "dense_vector", "dims": DIMS, "index": True,
                "similarity": similarity(), "index_options": options},
        "cat10": {"type": "integer"}, "cat100": {"type": "integer"},
        "cat1000": {"type": "integer"}, "cluster": {"type": "integer"},
        "id": {"type": "long", "index": False},
        "num": {"type": "integer"}, "lang": {"type": "keyword"},
        # Carried but never searched, so no inverted index and no doc values.
        "ts": {"type": "date", "index": False, "doc_values": False},
        "title": {"type": "keyword", "index": False, "doc_values": False},
    }
    settings = {"index": {
        "number_of_shards": cfg.shards, "number_of_replicas": 0,
        "refresh_interval": "-1",             # no refresh while ingesting
        "translog": {"durability": "async", "flush_threshold_age": "1h"},
        "merge": {"policy": {"segments_per_tier": 100}},
    }}
    body = {"settings": settings,
            "mappings": {"_source": {"excludes": ["emb"]}, "properties": properties}}
    out = es.json("PUT", f"/{INDEX}", body, allow_fail=True)
    if isinstance(out, dict) and "__error__" in out:
        raise SystemExit(f"mapping refused: {out['__error__'][:400]}")
    log(f"index {INDEX}: {json.dumps(options)}, similarity {similarity()}, {cfg.shards} shard(s)")


def shards() -> list[str]:
    base = os.path.join(DATASET_DIR, "base")
    return sorted(os.path.join(base, f) for f in os.listdir(base) if f.endswith(".parquet"))


def ingest(es: Es, cfg: IndexConfig) -> int:
    total = 0
    t0 = time.perf_counter()
    rows_all = sum(pq.ParquetFile(p).metadata.num_rows for p in shards())
    step = -(-rows_all // cfg.segments) if cfg.per_shard() > 1 else 0
    cut = step
    for path in shards():
        table = pq.read_table(path)
        cols = {name: table.column(name).to_numpy(zero_copy_only=False)
                for name in table.column_names if name != "emb"}
        emb = np.asarray(table.column("emb").to_pylist(), dtype=np.float32)
        rows = len(emb)
        for start in range(0, rows, BULK_DOCS):
            stop = min(start + BULK_DOCS, rows)
            lines: list[bytes] = []
            for i in range(start, stop):
                doc = {name: json_value(v[i]) for name, v in cols.items() if name != "id"}
                doc["id"] = int(cols["id"][i])
                doc["emb"] = emb[i]
                lines.append(dumps({"index": {"_id": str(int(cols["id"][i]))}}))
                lines.append(dumps(doc))
            payload = b"\n".join(lines) + b"\n"
            out = es.request("POST", f"/{INDEX}/_bulk", payload, "application/x-ndjson")
            if out.get("errors"):
                first = next(item for item in out["items"] if "error" in item.get("index", {}))
                raise SystemExit(f"bulk error: {json.dumps(first)[:400]}")
            total += stop - start
            if step and total >= cut:
                es.json("POST", f"/{INDEX}/_refresh")
                cut += step
        log(f"  {os.path.basename(path)}: {total} docs, {time.perf_counter() - t0:.1f}s")
    return total


def segment_docs(es: Es) -> list[int]:
    segs = es.json("GET", f"/_cat/segments/{INDEX}?format=json&h=shard,docs.count")
    return sorted(int(s["docs.count"]) for s in segs)


def compact(es: Es, cfg: IndexConfig) -> None:
    es.json("POST", f"/{INDEX}/_refresh")
    size = es.json("GET", f"/{INDEX}/_stats/store")["_all"]["primaries"]["store"]["size_in_bytes"]
    es.json("PUT", f"/{INDEX}/_settings",
            {"index": {"merge": {"policy": {"max_merged_segment": f"{size // cfg.segments + 1}b"}}}})
    before = segment_docs(es)
    log(f"after ingest: {len(before)} segment(s): {before}")
    out = es.json("POST", f"/{INDEX}/_forcemerge?max_num_segments={cfg.per_shard()}&wait_for_completion=false")
    task = out.get("task")
    t0 = time.perf_counter()
    while task:
        time.sleep(5)
        st = es.json("GET", f"/_tasks/{task}", allow_fail=True)
        if not isinstance(st, dict) or "__error__" in st or st.get("completed"):
            break
        log(f"forcemerge to {cfg.per_shard()} segment(s) per shard: {time.perf_counter() - t0:.0f}s")
    counts = segment_docs(es)
    log(f"compacted to {len(counts)} segment(s) in {time.perf_counter() - t0:.1f}s: {counts}")
    if len(counts) != cfg.segments:
        raise SystemExit(f"wanted {cfg.segments} segments, the index has {len(counts)}: {counts}")


def settle(es: Es) -> dict:
    es.json("POST", f"/{INDEX}/_refresh")
    es.json("PUT", f"/{INDEX}/_settings", {"index": {"refresh_interval": "1s"}})
    last, stable = None, 0
    while stable < SETTLE_POLLS:
        time.sleep(5)
        stats = es.json("GET", f"/{INDEX}/_stats/segments,store,merge")
        primaries = stats["_all"]["primaries"]
        segments = primaries["segments"]["count"]
        merges = primaries["merges"]["current"]
        stable = stable + 1 if (segments == last and merges == 0) else 0
        last = segments
        log(f"settle: segments={segments} merges_current={merges} stable={stable}/{SETTLE_POLLS}")
    stats = es.json("GET", f"/{INDEX}/_stats/store,segments")
    return {"segments": last,
            "index_bytes": stats["_all"]["primaries"]["store"]["size_in_bytes"]}


def main() -> None:
    cfg = IndexConfig.from_env()
    es = Es()
    phases: dict[str, float] = {}

    t = time.perf_counter()
    create_index(es, cfg)
    rows = ingest(es, cfg)
    phases["ingest"] = time.perf_counter() - t
    log(f"ingested {rows} docs in {phases['ingest']:.1f}s")

    t = time.perf_counter()
    compact(es, cfg)
    info = settle(es)
    phases["index"] = time.perf_counter() - t
    if info["segments"] != cfg.segments:
        raise SystemExit(f"wanted {cfg.segments} segments after settling, the index has {info['segments']}: {segment_docs(es)}")

    count = es.json("GET", f"/{INDEX}/_count")["count"]
    if count != rows:
        raise SystemExit(f"loaded {rows} rows but the index holds {count}")

    print("VECTORBENCH_PHASES=" + json.dumps({k: round(v, 3) for k, v in phases.items()}))
    print("VECTORBENCH_INFO=" + json.dumps(info | {"index": asdict(cfg)}))


if __name__ == "__main__":
    main()
