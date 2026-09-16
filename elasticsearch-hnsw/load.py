"""Ingest a prepared dataset into Elasticsearch and wait for the index to settle.

Reads the shards of $VECTORBENCH_DATASET_DIR/base, bulk-indexes them, then refreshes and waits for
merges to stop moving. Index parameters come from VB_INDEX_<KEY> (settings.yml section 6): type, m,
ef_construction, shards.

Prints the two load tags of docs/contracts.md section 4 on stdout."""

from __future__ import annotations

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

    @staticmethod
    def from_env() -> "IndexConfig":
        return IndexConfig(
            type=env_str("VB_INDEX_TYPE", "int8_hnsw").lower(),
            m=env_int("VB_INDEX_M", 16),
            ef_construction=env_int("VB_INDEX_EF_CONSTRUCTION", 128),
            shards=env_int("VB_INDEX_SHARDS", 1),
        )


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
        "num": {"type": "integer"}, "lang": {"type": "keyword"},
    }
    settings = {"index": {
        "number_of_shards": cfg.shards, "number_of_replicas": 0,
        "refresh_interval": "-1",             # no refresh while ingesting
        "translog": {"durability": "async"},
    }}
    # Turning _source off keeps a hit down to an id and a score. 9.x spells it as a mode and
    # deprecates the boolean, so the modern form is tried first and the old one is the fallback.
    errors: list[str] = []
    for name, source in (("mode", {"mode": "disabled"}), ("enabled", {"enabled": False})):
        body = {"settings": settings,
                "mappings": {"_source": source, "properties": properties}}
        out = es.json("PUT", f"/{INDEX}", body, allow_fail=True)
        if isinstance(out, dict) and "__error__" in out:
            errors.append(f"_source.{name}: {out['__error__'][:200]}")
            es.json("DELETE", f"/{INDEX}", allow_fail=True)
            continue
        log(f"index {INDEX}: {json.dumps(options)}, similarity {similarity()}, "
            f"{cfg.shards} shard(s), _source by {name}")
        return
    raise SystemExit("no mapping was accepted:\n  " + "\n  ".join(errors))


def shards() -> list[str]:
    base = os.path.join(DATASET_DIR, "base")
    return sorted(os.path.join(base, f) for f in os.listdir(base) if f.endswith(".parquet"))


def ingest(es: Es, cfg: IndexConfig) -> int:
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
    info = settle(es)
    phases["index"] = time.perf_counter() - t

    count = es.json("GET", f"/{INDEX}/_count")["count"]
    if count != rows:
        raise SystemExit(f"loaded {rows} rows but the index holds {count}")

    print("VECTORBENCH_PHASES=" + json.dumps({k: round(v, 3) for k, v in phases.items()}))
    print("VECTORBENCH_INFO=" + json.dumps(info | {"index": asdict(cfg)}))


if __name__ == "__main__":
    main()
