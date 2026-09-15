#!/usr/bin/env python3
"""Load recipe of the Qdrant HNSW participant (docs/contracts.md section 4), run by ./load.

Create the collection with indexing parked (indexing_threshold=0), index the attribute fields, upload
every base shard over gRPC from a few worker processes, then release the optimizer and block until the
graph covers every point, the optimizers are idle and the flush cycle has run. Progress goes to stderr;
the two tags go to stdout last.

Environment (exported by the driver, docs/contracts.md section 4): VECTORBENCH_DATASET_DIR,
VECTORBENCH_METRIC (ip | l2), VECTORBENCH_DIMS, VB_PORT, VB_GRPC_PORT, VB_COLLECTION, VB_UPLOAD_WORKERS
and the index parameters VB_INDEX_<KEY> of settings.yml (m, ef_construct, quant, on_disk_vectors,
on_disk_hnsw, segments, full_scan_threshold_kb, optional max_segment_size_kb)."""

from __future__ import annotations

import json
import multiprocessing as mp
import os
import sys
import time
from collections.abc import Iterator
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pyarrow.compute as pc
import pyarrow.parquet as pq
from qdrant_client import QdrantClient, models

DISTANCE = {"ip": models.Distance.DOT, "l2": models.Distance.EUCLID}
INTEGER = models.IntegerIndexType.INTEGER
PAYLOAD_INDEXES: dict[str, models.IntegerIndexParams | models.KeywordIndexParams] = {
    "cat10": models.IntegerIndexParams(type=INTEGER, lookup=True, range=False),
    "cat100": models.IntegerIndexParams(type=INTEGER, lookup=True, range=False),
    "cat1000": models.IntegerIndexParams(type=INTEGER, lookup=True, range=False),
    "num": models.IntegerIndexParams(type=INTEGER, lookup=False, range=True),
    "cluster": models.IntegerIndexParams(type=INTEGER, lookup=True, range=False),
    "lang": models.KeywordIndexParams(type=models.KeywordIndexType.KEYWORD),
}
PAYLOAD_COLUMNS = ("cat10", "cat100", "cat1000", "num", "ts", "cluster", "lang", "title")
INDEXING_THRESHOLD_KB = 1  # what the parked optimizer is released to; README says why not the default
UPLOAD_BATCH_BYTES = 8 << 20  # vectors per upsert (2048 points at 1024 dims)
SETTLE_POLL_S = 2.0
SETTLE_STABLE_READS = 3
READY_TIMEOUT_S = 60.0


def log(msg: str) -> None:
    print(f"[load] {msg}", file=sys.stderr, flush=True)


def env_str(name: str, default: str | None = None) -> str:
    v = os.environ.get(name, "").strip()
    if v in ("", "None"):
        if default is None:
            raise SystemExit(f"{name} is not set")
        return default
    return v


def env_int(name: str, default: int) -> int:
    return int(env_str(name, str(default)))


def env_bool(name: str, default: bool = False) -> bool:
    return env_str(name, str(default)).lower() in ("1", "true", "yes", "on")


@dataclass(frozen=True)
class Target:
    host: str
    port: int
    grpc_port: int
    collection: str

    @classmethod
    def from_env(cls) -> Target:
        return cls("127.0.0.1", env_int("VB_PORT", 6533), env_int("VB_GRPC_PORT", 6534), env_str("VB_COLLECTION", "items"))

    def connect(self, timeout: int = 600) -> QdrantClient:
        return QdrantClient(host=self.host, port=self.port, grpc_port=self.grpc_port, prefer_grpc=True,
                            timeout=timeout, check_compatibility=False)


@dataclass(frozen=True)
class IndexConfig:
    m: int
    ef_construct: int
    quant: str  # none | sq8 | binary
    on_disk_vectors: bool
    on_disk_hnsw: bool
    segments: int
    full_scan_threshold_kb: int
    max_segment_size_kb: int | None

    @classmethod
    def from_env(cls) -> IndexConfig:
        return cls(
            m=env_int("VB_INDEX_M", 16), ef_construct=env_int("VB_INDEX_EF_CONSTRUCT", 128),
            quant=env_str("VB_INDEX_QUANT", "none").lower(),
            on_disk_vectors=env_bool("VB_INDEX_ON_DISK_VECTORS"), on_disk_hnsw=env_bool("VB_INDEX_ON_DISK_HNSW"),
            segments=env_int("VB_INDEX_SEGMENTS", 8), full_scan_threshold_kb=env_int("VB_INDEX_FULL_SCAN_THRESHOLD_KB", 10),
            max_segment_size_kb=env_int("VB_INDEX_MAX_SEGMENT_SIZE_KB", 0) or None,
        )

    def quantization(self, metric: str) -> models.ScalarQuantization | models.BinaryQuantization | None:
        if self.quant == "none":
            return None
        if self.quant == "sq8":
            return models.ScalarQuantization(scalar=models.ScalarQuantizationConfig(type=models.ScalarType.INT8, quantile=0.99, always_ram=True))
        if self.quant == "binary":
            if metric != "ip":
                raise SystemExit("quant=binary keeps only the sign of each dimension: meaningful for ip, not for l2")
            return models.BinaryQuantization(binary=models.BinaryQuantizationConfig(always_ram=True))
        raise SystemExit(f"unknown quant {self.quant!r}; use none, sq8 or binary")


def wait_ready(client: QdrantClient, timeout: float = READY_TIMEOUT_S) -> None:
    deadline = time.perf_counter() + timeout
    while True:
        try:
            client.get_collections()
            return
        except Exception as e:  # noqa: BLE001 - any transport error while the server comes up
            if time.perf_counter() > deadline:
                raise SystemExit(f"qdrant did not answer within {timeout:.0f}s: {e}") from e
            time.sleep(0.5)


def create_collection(client: QdrantClient, target: Target, dims: int, metric: str, cfg: IndexConfig) -> None:
    """A fresh collection with indexing parked, plus a payload index per attribute the filters use."""
    if metric not in DISTANCE:
        raise SystemExit(f"unsupported metric {metric!r}; this participant runs ip (Dot) and l2 (Euclid)")
    if client.collection_exists(target.collection):
        client.delete_collection(target.collection)
    client.create_collection(
        collection_name=target.collection,
        vectors_config=models.VectorParams(size=dims, distance=DISTANCE[metric], on_disk=cfg.on_disk_vectors),
        hnsw_config=models.HnswConfigDiff(m=cfg.m, ef_construct=cfg.ef_construct, full_scan_threshold=cfg.full_scan_threshold_kb, on_disk=cfg.on_disk_hnsw),
        optimizers_config=models.OptimizersConfigDiff(indexing_threshold=0, default_segment_number=cfg.segments, max_segment_size=cfg.max_segment_size_kb),
        quantization_config=cfg.quantization(metric),
    )
    for field, schema in PAYLOAD_INDEXES.items():
        client.create_payload_index(target.collection, field, schema, wait=True)


def base_shards(dataset_dir: Path) -> list[Path]:
    shards = sorted((dataset_dir / "base").glob("part_*.parquet"))
    if not shards:
        raise SystemExit(f"no base/part_*.parquet under {dataset_dir}")
    return shards


def shard_batches(path: Path, dims: int) -> Iterator[models.Batch]:
    """One shard as upsert batches: ids from the `id` column, vectors, the attribute columns as payload."""
    table = pq.read_table(path)
    n = len(table)
    ids = table.column("id").to_numpy().tolist()
    emb = table.column("emb").combine_chunks().flatten().to_numpy(zero_copy_only=False)
    vectors = np.ascontiguousarray(emb, dtype=np.float32).reshape(n, dims)
    columns = {c: table.column(c) for c in PAYLOAD_COLUMNS}
    columns["ts"] = pc.strftime(columns["ts"], format="%Y-%m-%dT%H:%M:%SZ")  # RFC 3339, Qdrant's datetime form
    lists = [columns[c].to_pylist() for c in PAYLOAD_COLUMNS]
    payloads = [dict(zip(PAYLOAD_COLUMNS, row)) for row in zip(*lists)]
    step = max(1, UPLOAD_BATCH_BYTES // (dims * 4))
    for i in range(0, n, step):
        j = min(i + step, n)
        yield models.Batch(ids=ids[i:j], vectors=vectors[i:j].tolist(), payloads=payloads[i:j])


_worker_client: QdrantClient | None = None


def upload_shard(job: tuple[Target, Path, int]) -> int:
    """Upload one shard with wait=False (acknowledged by the WAL); runs in a worker process."""
    global _worker_client
    target, path, dims = job
    if _worker_client is None:
        _worker_client = target.connect()
    rows = 0
    for batch in shard_batches(path, dims):
        _worker_client.upsert(target.collection, points=batch, wait=False)
        rows += len(batch.ids)
    log(f"uploaded {path.name}: {rows} rows")
    return rows


def upload(target: Target, dims: int, shards: list[Path], workers: int) -> int:
    jobs = [(target, p, dims) for p in shards]
    if workers <= 1 or len(shards) == 1:
        return sum(upload_shard(j) for j in jobs)
    # spawn, not fork: a forked child of a process holding a gRPC channel is not supported by grpc.
    with mp.get_context("spawn").Pool(min(workers, len(shards))) as pool:
        return sum(pool.imap_unordered(upload_shard, jobs))


def drain(client: QdrantClient, target: Target, rows: int) -> None:
    """wait=False upserts are acknowledged before they are applied; wait until every point is countable."""
    while True:
        n = int(client.count(target.collection, exact=True).count)
        if n >= rows:
            if n > rows:
                raise SystemExit(f"collection holds {n} points, expected {rows}")
            return
        time.sleep(0.5)


def wait_settled(client: QdrantClient, target: Target, rows: int, stable_reads: int = SETTLE_STABLE_READS) -> models.CollectionInfo:
    """Return when `stable_reads` consecutive reads say: GREEN, optimizers ok, empty update queue, every
    point in the graph, segment count unchanged. GREEN alone is not enough: a parked collection is GREEN."""
    stable, last_segments, last_log = 0, -1, 0.0
    while True:
        info = client.get_collection(target.collection)
        if info.status == models.CollectionStatus.RED or info.optimizer_status != models.OptimizersStatusOneOf.OK:
            raise SystemExit(f"collection unhealthy: status={info.status} optimizer_status={info.optimizer_status}")
        queued = info.update_queue.length if info.update_queue is not None else 0
        settled = (info.status == models.CollectionStatus.GREEN and queued == 0 and info.points_count == rows
                   and info.indexed_vectors_count == rows and info.segments_count == last_segments)
        stable = stable + 1 if settled else 0
        last_segments = info.segments_count
        if stable >= stable_reads:
            return info
        if time.perf_counter() - last_log >= 30:
            log(f"status={info.status.value} indexed={info.indexed_vectors_count}/{rows} segments={info.segments_count} queued={queued}")
            last_log = time.perf_counter()
        time.sleep(SETTLE_POLL_S)


def build_index(client: QdrantClient, target: Target, rows: int) -> models.CollectionInfo:
    """Release the optimizer, wait until the graph is complete and idle, then let the flush cycle run: the
    WAL is truncated and replaced segments are removed only on its next passes, and data-size follows."""
    client.update_collection(target.collection, optimizers_config=models.OptimizersConfigDiff(indexing_threshold=INDEXING_THRESHOLD_KB))
    info = wait_settled(client, target, rows)
    time.sleep(2 * int(info.config.optimizer_config.flush_interval_sec or 5) + 1)
    return wait_settled(client, target, rows, stable_reads=1)


def info_tag(info: models.CollectionInfo, cfg: IndexConfig, workers: int) -> dict[str, Any]:
    return {
        "segments": info.segments_count, "points": info.points_count, "indexed_vectors": info.indexed_vectors_count,
        "index": asdict(cfg), "payload_indexes": sorted(info.payload_schema),
        "indexing_threshold_kb": INDEXING_THRESHOLD_KB, "upload_workers": workers,
    }


def main() -> int:
    dataset_dir = Path(env_str("VECTORBENCH_DATASET_DIR"))
    metric, dims = env_str("VECTORBENCH_METRIC"), env_int("VECTORBENCH_DIMS", 0)
    target, cfg, workers = Target.from_env(), IndexConfig.from_env(), env_int("VB_UPLOAD_WORKERS", 4)
    shards = base_shards(dataset_dir)
    rows = sum(pq.read_metadata(p).num_rows for p in shards)
    width = pq.read_schema(shards[0]).field("emb").type.list_size
    if width != dims:
        raise SystemExit(f"emb has {width} dims, VECTORBENCH_DIMS says {dims}")
    client = target.connect()
    wait_ready(client)
    log(f"{rows} rows in {len(shards)} shards, {dims} dims, metric {metric}, {workers} upload workers")
    log(f"index {asdict(cfg)}")

    t0 = time.perf_counter()
    create_collection(client, target, dims, metric, cfg)
    uploaded = upload(target, dims, shards, workers)
    if uploaded != rows:
        raise SystemExit(f"uploaded {uploaded} rows, expected {rows}")
    drain(client, target, rows)
    t1 = time.perf_counter()
    log(f"ingest done in {t1 - t0:.1f}s, building the index")
    info = build_index(client, target, rows)
    t2 = time.perf_counter()
    log(f"index done in {t2 - t1:.1f}s: {info.segments_count} segments, {info.indexed_vectors_count} indexed vectors")
    client.close()

    print("VECTORBENCH_PHASES=" + json.dumps({"ingest": round(t1 - t0, 3), "index": round(t2 - t1, 3)}))
    print("VECTORBENCH_INFO=" + json.dumps(info_tag(info, cfg, workers)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
