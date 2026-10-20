# Qdrant HNSW

Participant `qdrant-hnsw`: [Qdrant](https://qdrant.tech) with its HNSW index, one collection per
dataset size, searched over gRPC with the official `qdrant-client`.

| | |
|---|---|
| Image | `qdrant/qdrant:v1.19.1` (`settings.yml: env.image`). `install` pulls it only when the tag is not present locally, so a locally built or `docker load`ed image under that tag is used as is. |
| Ports | REST `127.0.0.1:6533`, gRPC `127.0.0.1:6534` (container ports 6333 / 6334, published on loopback only) |
| Client | `qdrant-client` 1.19 over gRPC (`prefer_grpc=True`), `Points/Query` |
| Collection | `items`: one dense vector (`Dot` for `ip`, `Euclid` for `l2`), the attribute columns as payload, point ids = the `id` column |
| Container | `vectorbench-qdrant-hnsw`, `--cpuset-cpus`, `--memory` with `--memory-swap` equal to it (no swap), `--security-opt seccomp=unconfined`, storage bind-mounted at `/qdrant/storage` |

## Prerequisites

- Docker with a reachable daemon. The official image runs as root, so its files in the bind mount belong
  to root; `install` removes them from a throwaway root container of the same image when the host user
  cannot.
- A host Python with `numpy`, `pyarrow` and `qdrant-client` for `load` and `client.py`: the repository's
  `.venv` has them. `install` and `load` use `$VECTORBENCH_PYTHON` if set, else `../.venv/bin/python` if
  present, else `python3` on `PATH`.
- `curl` and coreutils for `check`, `version`, `data-size`.

## Files

| file | role |
|---|---|
| `benchmark.sh` | exports `ENGINE_NAME="Qdrant HNSW"`, `ENGINE_TAGS='["Rust","Qdrant"]'`, execs `../lib/benchmark.sh` |
| `install`, `start`, `stop`, `check`, `version`, `data-size` | the shell contract of docs/contracts.md section 4 |
| `load`, `load.py` | the whole load recipe (below); `load` only picks the interpreter |
| `settings.yml` | participant identity, ports and image, per-size index configuration and `hnsw_ef` ladders |
| `queries.json` | one block per group in Qdrant's REST filter dialect (below) |
| `client.py` | `class Client` for the driver's worker processes |
| `smoke_test.py` | standalone end-to-end test against any running Qdrant (below) |

## Environment the scripts read

Exported by the driver (docs/contracts.md section 4); the defaults written into the scripts mirror
`settings.yml` so they also work by hand.

| variable | used by |
|---|---|
| `VECTORBENCH_DATASET_DIR` | `load`: `base/part_*.parquet` |
| `VECTORBENCH_ENGINE_DIR` | `install` (wiped), `start` (bind mount), `data-size` |
| `VECTORBENCH_CPUSET`, `VECTORBENCH_MEMORY` | `start`; an empty value means no limit |
| `VECTORBENCH_METRIC`, `VECTORBENCH_DIMS` | `load`; `check` builds its probe vector from `DIMS` (without it, it probes `/readyz`) |
| `VB_PORT`, `VB_GRPC_PORT`, `VB_CONTAINER`, `VB_IMAGE`, `VB_COLLECTION`, `VB_UPLOAD_WORKERS` | from `settings.yml: env` |
| `VB_INDEX_M`, `VB_INDEX_EF_CONSTRUCT`, `VB_INDEX_QUANT`, `VB_INDEX_ON_DISK_VECTORS`, `VB_INDEX_ON_DISK_HNSW`, `VB_INDEX_SEGMENTS`, `VB_INDEX_FULL_SCAN_THRESHOLD_KB`, optional `VB_INDEX_MAX_SEGMENT_SIZE_KB` | `load` (the size's resolved `index` block) |
| optional `VB_INDEX_ASYNC_SCORER` | `start` (server setting `QDRANT__STORAGE__PERFORMANCE__ASYNC_SCORER`) |

Booleans arrive as the driver formats them (`True`/`False`); `load.py` accepts `1/true/yes/on` in any
case. `client.py` gets `settings.yml: connection` plus the driver's `metric`, `dims`, `dataset`; it uses
`host`, `port`, `grpc_port`, `collection`, `timeout` and ignores the rest (Qdrant needs neither the
metric nor the width at query time).

## Load recipe (`load` -> `load.py`)

1. Fresh collection: `VectorParams(size=dims, distance, on_disk=on_disk_vectors)`,
   `HnswConfigDiff(m, ef_construct, full_scan_threshold=full_scan_threshold_kb, on_disk=on_disk_hnsw)`,
   `OptimizersConfigDiff(indexing_threshold=0, default_segment_number=segments, max_segment_size=max_segment_size_kb)`,
   optional quantization (`quant: sq8` = int8 scalar, quantile 0.99, in RAM; `quant: binary`, `ip` only).
2. Payload indexes before the upload: `cat10`, `cat100`, `cat1000`, `cluster` integer (lookup), `num`
   integer (range), `lang` keyword.
3. Upload: `upload_workers` processes, one shard each at a time, `upsert(wait=False)` in batches of 8 MiB
   of vectors (2048 points at 1024 dims); payload = `cat10 cat100 cat1000 num ts cluster lang title`,
   `ts` as an RFC 3339 string (Qdrant's datetime form). Then wait until `count(exact=True)` equals the row
   count: `wait=False` acknowledges a batch when it is in the WAL, not when it is applied.
4. Release the optimizer (`indexing_threshold` 0 -> 1 KB) and wait until three consecutive reads, 2 s
   apart, show status GREEN, optimizer status ok, an empty update queue, `points_count` and
   `indexed_vectors_count` equal to the row count and an unchanged segment count; then wait two flush
   intervals plus one second (11 s), during which Qdrant truncates the WAL and removes the segments the
   optimizer replaced, and read once more.
5. Print `VECTORBENCH_PHASES={"ingest", "index"}` (seconds; ingest = steps 1-3, index = step 4) and
   `VECTORBENCH_INFO` with `segments`, `points`, `indexed_vectors`, the index block, the payload indexes,
   `indexing_threshold_kb` and `upload_workers`.

Measured on the development host with the native binary, 100k x 1024 with the six payload indexes:
ingest 7.8k rows/s from one process and 25k rows/s from four (the Python client's protobuf encoding is
the bottleneck, hence the workers), graph build 18 s.

## What `data-size` counts

Allocated bytes (`du -sB1`) of the engine directory, `/qdrant/storage` in the container: the
collection's segments (vectors, HNSW graph including its payload links, payload storage, payload
indexes), the collection WAL (32 MiB segments, truncated after every flush, so a few of them), collection
metadata and `raft_state.json`. Allocated rather than apparent size because Qdrant preallocates sparse
WAL segments and storage chunks: the same 40k x 1024 collection measured 542 MiB apparent against 215 MiB
allocated. Measured inside the running container (root-owned files), from the host otherwise.

## Index configuration and ladders

One configuration per dataset size (`settings.yml`), the search knob is `hnsw_ef`:

| key | default | meaning |
|---|---|---|
| `m`, `ef_construct` | 16, 128 | HNSW graph |
| `quant` | `none` | `none`, `sq8` (int8 scalar), `binary`; quantized searches add `"quantization": {"rescore": .., "oversampling": ..}` to a block's `params` |
| `on_disk_vectors`, `on_disk_hnsw` | false | mmap the originals / the graph instead of holding them in RAM |
| `segments` | 8 | pinned `default_segment_number` |
| `full_scan_threshold_kb` | 10 | Qdrant's planner threshold, see the facts below |
| `max_segment_size_kb` | unset | cap on a segment (Qdrant's automatic value depends on the CPU count) |
| `async_scorer` | false | Qdrant's io_uring rescorer, relevant with `on_disk_vectors` |

## Rescoring the quantized candidates

With `quant: sq8` the graph is searched on 8-bit codes, so the candidate order is the quantized one
and the answer is capped by how well those codes rank. On sift at a million rows the cap showed
itself plainly: recall stopped climbing at 0.97 for k=10 and 0.985 for k=1000, and a wider beam made
it no better, so the 0.99 rows could not be read at all.

Every approximate block therefore asks for `rescore: true` and carries `oversampling` as a second
ladder knob. Qdrant then takes `limit * oversampling` candidates by quantized score and reorders
them with the full-precision vectors. The knob is swept like `hnsw_ef`, so the frontier picks
whichever pool a recall bar wants, rather than the participant guessing one. This matches what the
other participants do: Elasticsearch declares `rescore_vector.oversample`, and SereneDB reranks its
beam from the stored vectors.

Ladders: the size's default ladder serves k=10; the k=100 and k=1000 groups have their own, wider
ladders (YAML anchors, one per size), because Qdrant never searches a segment with a beam narrower than
the number of results it asks that segment for. wiki-v3-1024 starts at 16 (100k) / 24 (1m), sift-128 at
8 / 12; k=1000 ladders run from 128-256 to 3000-4000. These are initial guesses to be revised after the
first 100k and 1m runs; the version history below records the revisions.

## Queries (`queries.json`) and client

A block is `{"filter": <REST filter> | null, "params": {...}}`. Filters use `must` clauses with
`match.value` for equality and `range.gte/lte` for ranges; the arguments are the string placeholders
`"$v"`, `"$lo"`, `"$hi"`, `"$s"` that `client.py` replaces per query (`integer` match for ints, `keyword`
for strings). `params.hnsw_ef` carries the ladder knob `{hnsw_ef}`; the exact groups (`exact/none/*`,
`exact/eq-1/*`) carry `params.exact = true`, Qdrant's brute-force path, and no knob.

`client.py` builds the gRPC request itself and calls the `Points/Query` stub that `qdrant-client` exposes
as `client.grpc_points`, with `with_payload` and `with_vectors` off, and returns `[point.id.num ...]` in
rank order. Point ids are the `id` column values.

## Facts that are not in the code

- **io_uring and seccomp.** Docker's default seccomp profile denies `io_uring_setup`; Qdrant's
  `async_scorer` then does nothing, silently, and starts clean. `start` runs the container with
  `--security-opt seccomp=unconfined` so that `async_scorer: true` is effective when a configuration asks
  for it. It only matters for `on_disk_vectors`; the default configuration keeps everything in RAM.
- **Segments are pinned.** Without `default_segment_number` Qdrant derives the count from the CPUs it
  sees (2..8). Every segment is searched with the full beam and the results are merged, so recall at a
  fixed `hnsw_ef` depends on the segment count, and load time on the number of graphs built. Segments
  also have a size cap: unset, Qdrant chooses it from the CPU count (a 247M-row run of the earlier
  adapter ended with 323 segments of ~767k points despite `default_segment_number=2`). Set
  `max_segment_size_kb` above `rows / segments x vector bytes` for sizes where 8 segments would exceed the
  automatic cap (10m and up at 1024 dims).
- **`indexing_threshold=0` parks the optimizer**, and a parked collection reports GREEN with zero indexed
  vectors, so GREEN alone never means "built"; `load` requires `indexed_vectors_count == points_count`.
  It is released to 1 KB, not to Qdrant's default 20,000 KB: a sift-128 100k segment holds 6.4 MB of
  vectors and would stay a plain (brute-force) segment under the default.
- **`hnsw_ef` and `limit`.** On a single segment `hnsw_ef` below k is identical to `hnsw_ef = k` (the beam
  is `max(hnsw_ef, k)`), so a k=1000 group never runs with a narrow beam. With several segments Qdrant
  also samples how many results to ask each segment for, between `hnsw_ef` and k, so values below k still
  change the result: 8 segments, 20k x 32 random vectors, k=100 gave recall 0.949 at `hnsw_ef` 16, 0.991
  at 64, 0.998 at 100.
- **`full_scan_threshold` (KB) does two things.** It is the planner's threshold for answering a segment
  by brute force (unfiltered when the segment is smaller than it, filtered when the estimated match count
  is), and the block size above which Qdrant adds payload-aware links to the graph for each indexed value
  ("filterable HNSW"). Qdrant's default of 10,000 KB is 20k points at 128 dims, more than a 100k-row
  segment holds, so sift-128 100k would be brute force without touching the graph. At 10 KB every
  unfiltered search goes through the graph and every filtered one too unless fewer than about 3 (1024
  dims) or 20 (128 dims) points match. The price is build time and graph size: 18.1 s against 11.1 s for
  100k x 1024 with the six payload indexes.
- **The client conversion is the k=1000 cost.** `QdrantClient.query_points` turns every returned point into
  a pydantic model: 8.5 ms per query at k=1000 against 2.9 ms for the same request through the gRPC stub
  (0.1 ms difference at k=10). The stub is the same official driver, so `client.py` uses it.
- **Disk settles after the optimizer does.** Right after the collection reports built, the replaced
  segments and the WAL are still on disk (1271 MiB against 542 MiB ten seconds later for 40k x 1024);
  Qdrant's flush worker (`flush_interval_sec`, 5 s) truncates and removes them. `load` waits for it.
- **Startup is honest.** Qdrant opens its ports only after every collection is loaded, so the first
  successful `check` (a real 1-NN search with a zero vector, or `/collections/<name>/exists` when there is
  no collection yet) is the moment the engine can search.
- **Upload workers are spawned, not forked**: grpc does not support forking a process that holds a channel,
  and the main process has one by then. Qdrant accepted 16 MiB upsert batches over gRPC; 8 MiB is used.

## Smoke test

`smoke_test.py` needs only a running Qdrant (no driver package): it builds 40,000 random 32-dim rows with
the attribute columns of docs/contracts.md section 2 (local splitmix64 copy, random centroids), writes
them as two parquet shards to a temporary directory, loads them with `load.py`'s functions (collection,
payload indexes, two upload workers, index, settle), and drives `client.py` through every group key of
`queries.json` for `ip` and `l2`, checking that exactly k distinct known ids come back, that every id
satisfies the predicate (evaluated in numpy), that the exact groups return the true top-k, and that the
approximate groups stay above a loose recall floor. About a minute.

Against the native binary, from the repository root:

```bash
curl -sL -o /tmp/qdrant.tgz https://github.com/qdrant/qdrant/releases/download/v1.19.1/qdrant-x86_64-unknown-linux-gnu.tar.gz
mkdir -p /tmp/qdrant && tar -xzf /tmp/qdrant.tgz -C /tmp/qdrant
QDRANT__SERVICE__HTTP_PORT=6434 QDRANT__SERVICE__GRPC_PORT=6433 QDRANT__STORAGE__STORAGE_PATH=/tmp/qdrant/storage \
  QDRANT__TELEMETRY_DISABLED=true /tmp/qdrant/qdrant &
.venv/bin/python qdrant-hnsw/smoke_test.py --port 6434 --grpc-port 6433
```

Against the container started by this participant, the default ports apply: `.venv/bin/python
qdrant-hnsw/smoke_test.py`.

## Version history

| date | image | change |
|---|---|---|
