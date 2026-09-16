"""Ingest a prepared dataset into OpenSearch and wait for the index to settle.

Reads the shards of $VECTORBENCH_DATASET_DIR/base, bulk-indexes them, then refreshes and waits for
merges to stop moving. Index parameters come from VB_INDEX_<KEY> (settings.yml section 6): engine,
engine, m, ef_construction, shards, compression_level.

The k-NN plugin has changed how quantization is declared more than once, so the mapping is tried in
descending order of expressiveness and the first one the server accepts is used. Whatever it built
is read back from the mapping and reported, so the result file records what ran rather than what
was asked for.

Prints the two load tags of docs/contracts.md section 4 on stdout."""

from __future__ import annotations

import http.client
import json
import os
import time
from dataclasses import asdict, dataclass
from typing import Any

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
    engine: str
    m: int
    ef_construction: int
    shards: int
    compression_level: str

    @staticmethod
    def from_env() -> "IndexConfig":
        return IndexConfig(
            engine=env_str("VB_INDEX_ENGINE", "lucene").lower(),
            m=env_int("VB_INDEX_M", 16),
            ef_construction=env_int("VB_INDEX_EF_CONSTRUCTION", 128),
            shards=env_int("VB_INDEX_SHARDS", 1),
            compression_level=env_str("VB_INDEX_COMPRESSION_LEVEL", "4x").lower(),
        )


class Os:
    """The bits of the REST API this loader needs, over one kept-alive connection."""

    def __init__(self) -> None:
        self.conn = http.client.HTTPConnection(HOST, PORT, timeout=1200)

    def request(self, method: str, path: str, body: bytes | None = None,
                content_type: str = "application/json", allow_fail: bool = False) -> Any:
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

    def json(self, method: str, path: str, body: dict | None = None, allow_fail: bool = False) -> Any:
        payload = json.dumps(body).encode() if body is not None else None
        return self.request(method, path, payload, allow_fail=allow_fail)


def space_type() -> str:
    # innerproduct on faiss ranks by the dot product; l2 by squared distance. The prepared corpora
    # are not normalised for every family, so cosine is never used.
    return "l2" if METRIC == "l2" else "innerproduct"


def _method(cfg: IndexConfig) -> dict[str, Any]:
    return {"name": "hnsw", "engine": cfg.engine,
            "parameters": {"m": cfg.m, "ef_construction": cfg.ef_construction}}


def mapping_variants(cfg: IndexConfig) -> list[tuple[str, dict[str, Any]]]:
    """Field mappings to try, the asked-for build first.

    Not every engine takes every compression level in 3.8, and the pairs are not symmetric:

    | compression | bits per dimension | faiss | lucene |
    |---|---|---|---|
    | 1x  | 32 (float)  | yes | yes |
    | 2x  | 16 (fp16)   | yes | no  |
    | 4x  | 8 (byte)    | no  | yes |
    | 8x  | 4           | yes | no  |
    | 16x | 2           | yes | no  |
    | 32x | 1 (binary)  | yes | yes |

    So eight-bit codes, which is what the other participants build, are reachable only through
    Lucene here; faiss jumps from sixteen bits to four. The fallback drops the compression rather
    than the engine, and says so, because a run that silently became full precision is not a
    matched build and must be visible as such in the result file.
    """
    base = {"type": "knn_vector", "dimension": DIMS, "space_type": space_type()}
    method = {"name": "hnsw", "engine": cfg.engine,
              "parameters": {"m": cfg.m, "ef_construction": cfg.ef_construction}}
    out: list[tuple[str, dict[str, Any]]] = []
    if cfg.compression_level and cfg.compression_level != "1x":
        out.append((f"{cfg.engine}-{cfg.compression_level}",
                    base | {"compression_level": cfg.compression_level, "method": method}))
    out.append((f"{cfg.engine}-uncompressed", base | {"method": method}))
    return out


def create_index(es: Os, cfg: IndexConfig) -> str:
    es.json("DELETE", f"/{INDEX}", allow_fail=True)
    settings = {"index": {
        "knn": True,
        "number_of_shards": cfg.shards, "number_of_replicas": 0,
        "refresh_interval": "-1",             # no refresh while ingesting
        "translog": {"durability": "async"},
    }}
    errors: list[str] = []
    for name, field in mapping_variants(cfg):
        body = {"settings": settings, "mappings": {
            "_source": {"enabled": False}, "properties": {
                "emb": field,
                "cat10": {"type": "integer"}, "cat100": {"type": "integer"},
                "cat1000": {"type": "integer"}, "cluster": {"type": "integer"},
                "num": {"type": "integer"}, "lang": {"type": "keyword"},
            }}}
        out = es.json("PUT", f"/{INDEX}", body, allow_fail=True)
        if isinstance(out, dict) and "__error__" in out:
            errors.append(f"{name}: {out['__error__'][:200]}")
            es.json("DELETE", f"/{INDEX}", allow_fail=True)
            continue
        if name != mapping_variants(cfg)[0][0]:
            log(f"WARNING: {mapping_variants(cfg)[0][0]} was refused, falling back to {name}; "
                f"this is NOT the build that was asked for")
        log(f"index {INDEX}: mapping variant {name!r}, space_type {space_type()}, {cfg.shards} shard(s)")
        return name
    raise SystemExit("no knn_vector mapping was accepted:\n  " + "\n  ".join(errors))


def shards() -> list[str]:
    base = os.path.join(DATASET_DIR, "base")
    return sorted(os.path.join(base, f) for f in os.listdir(base) if f.endswith(".parquet"))


def ingest(es: Os, _cfg: IndexConfig) -> int:
    total = 0
    t0 = time.perf_counter()
    for path in shards():
        table = pq.read_table(path)
        cols = {name: table.column(name).to_numpy(zero_copy_only=False)
                for name in table.column_names if name != "emb"}
        emb = np.asarray(table.column("emb").to_pylist(), dtype=np.float32)
        rows = len(emb)
        for start in range(0, rows, BULK_DOCS):
            stop = min(start + BULK_DOCS, rows)
            lines: list[str] = []
            for i in range(start, stop):
                doc = {name: (v[i].item() if hasattr(v[i], "item") else v[i])
                       for name, v in cols.items() if name != "id"}
                doc["emb"] = emb[i].tolist()
                lines.append(json.dumps({"index": {"_id": str(int(cols["id"][i]))}}))
                lines.append(json.dumps(doc, separators=(",", ":")))
            payload = ("\n".join(lines) + "\n").encode()
            out = es.request("POST", f"/{INDEX}/_bulk", payload, "application/x-ndjson")
            if out.get("errors"):
                first = next(item for item in out["items"] if "error" in item.get("index", {}))
                raise SystemExit(f"bulk error: {json.dumps(first)[:400]}")
            total += stop - start
        log(f"  {os.path.basename(path)}: {total} docs, {time.perf_counter() - t0:.1f}s")
    return total


def settle(es: Os) -> dict:
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
    # Warm the native graphs so the first measured query does not pay the mmap and load: the plugin
    # loads an index lazily on first search, which would otherwise land in the benchmark.
    es.json("GET", f"/_plugins/_knn/warmup/{INDEX}", allow_fail=True)
    stats = es.json("GET", f"/{INDEX}/_stats/store,segments")
    return {"segments": last,
            "index_bytes": stats["_all"]["primaries"]["store"]["size_in_bytes"]}


def built_mapping(es: Os) -> dict[str, Any]:
    out = es.json("GET", f"/{INDEX}/_mapping", allow_fail=True)
    try:
        return out[INDEX]["mappings"]["properties"]["emb"]
    except (KeyError, TypeError):
        return {}


def main() -> None:
    cfg = IndexConfig.from_env()
    es = Os()
    phases: dict[str, float] = {}

    t = time.perf_counter()
    variant = create_index(es, cfg)
    rows = ingest(es, cfg)
    phases["ingest"] = time.perf_counter() - t
    log(f"ingested {rows} docs in {phases['ingest']:.1f}s")

    t = time.perf_counter()
    info = settle(es)
    phases["index"] = time.perf_counter() - t

    count = es.json("GET", f"/{INDEX}/_count")["count"]
    if count != rows:
        raise SystemExit(f"loaded {rows} rows but the index holds {count}")

    print("VECTORBENCH_PHASES=" + json.dumps({k: round(v, 3) for k, v in phases.items()}))
    print("VECTORBENCH_INFO=" + json.dumps(
        info | {"index": asdict(cfg), "mapping_variant": variant, "field": built_mapping(es)}))


if __name__ == "__main__":
    main()
