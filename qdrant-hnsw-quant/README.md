# Qdrant HNSW

Participant `qdrant-hnsw-quant`: [Qdrant](https://qdrant.tech) with its HNSW index and quantized
vectors, one collection per dataset size, searched over gRPC with the official `qdrant-client`.

| | |
|---|---|
| Image | `qdrant/qdrant:v1.20.0` (`settings.yml: env.image`). `install` pulls it only when the tag is not present locally. |
| Ports | REST `127.0.0.1:6535`, gRPC `127.0.0.1:6536`, host networking |
| Client | `qdrant-client` over gRPC, the `Points/Query` stub, one connection per client process |
| Collection | `items`: one dense vector (`Dot` for `ip`, `Euclid` for `l2`), the attribute columns as payload, point ids = the `id` column |
| Container | `vectorbench-qdrant-hnsw-quant`, optional `--cpuset-cpus` and `--memory` (no swap), `--security-opt seccomp=unconfined`, storage bind-mounted at `/qdrant/storage` |

## Load recipe (`load` -> `load.py`)

1. A fresh collection with indexing parked (`indexing_threshold` 0): `VectorParams(on_disk)`,
   `HnswConfigDiff(m, ef_construct, full_scan_threshold, payload_m)`,
   `OptimizersConfigDiff(default_segment_number, max_segment_size)` and the quantization below.
2. Payload indexes before the upload: `cat10`, `cat100`, `cat1000`, `cluster` integer (lookup), `num`
   integer (range), `lang` keyword, with the `memory` mode from settings.
3. Upload from 4 worker processes, one shard each at a time, `upsert(wait=False)` in batches of 8 MiB
   of vectors; then wait until `count(exact=True)` equals the row count.
4. Release the optimizer (`indexing_threshold` 1 KB) and wait until three consecutive reads, 2 s
   apart, show status green, an idle optimizer, every vector indexed and an unchanged segment count;
   then wait two flush intervals so Qdrant truncates its WAL and removes the replaced segments.
5. Print `VECTORBENCH_PHASES` (`ingest` = steps 1-3, `index` = step 4) and `VECTORBENCH_INFO`.

## What `data-size` counts

Allocated bytes (`du -sB1`) of `/qdrant/storage`: segments (vectors, graph, quantized codes, payload
and payload indexes), WAL and metadata. Allocated rather than apparent size, because Qdrant
preallocates sparse WAL segments and storage chunks.

## Index configuration per size

| size | codes | float vectors | rescoring |
|---|---|---|---|
| `wiki-v3-1024-247m` | TurboQuant, 2 bits (`bits2`), `always_ram` | on disk (`on_disk: true`) | `rescore: true`, swept by `oversample` |
| `wiki-v3-1024-10m` | scalar int8, `quantile` 0.99, `always_ram` | on disk (`on_disk: true`), read into the page cache before the pass; queries never touch them | `rescore: false` |

Both: `m = 16`, `ef_construct = 256`, `default_segment_number = 8` (Qdrant ended with 9 segments at
247m and 11 at 10m), the graph in RAM, payload indexes `memory: cold` (memory-mapped, read on demand),
`full_scan_threshold` 10,000 KB (Qdrant's default).

Settings that differ from Qdrant's defaults, and why:

- `payload_m: 0`. By default Qdrant adds extra graph links for every value of every indexed field;
  with six indexed fields on 247 million points those graphs would not fit in memory. With
  `payload_m` 0 Qdrant, like SereneDB, searches one graph per segment and uses a payload index for
  the filter. Both sizes use the same setting.
- `max_segment_size` 140,000,000 KB at 247m, so the 8 segments are not split by Qdrant's automatic
  size cap.
- During the 247m index phase only (`VB_QDRANT_MMAP_ADVICE`, `VB_QDRANT_MAX_OPTIMIZATION_THREADS`,
  read by `start`): `mmap_advice: sequential`, because with the default random advice building a
  segment reads its vectors back one 4 KB page at a time, and 4 optimization threads, because with
  the default the index phase runs out of memory. Queries run with Qdrant's defaults.

## Queries (`queries.json`) and knobs

A block is `{"filter": <REST filter> | null, "params": {...}}`. Filters use `must` clauses with
`match.value` for equality and `range.gte/lte` for ranges; `client.py` replaces the placeholders
`"$v"`, `"$lo"`, `"$hi"`, `"$s"` per query.

| knob | parameter | meaning |
|---|---|---|
| `hnsw_ef` | `params.hnsw_ef` | the beam of the graph walk in every segment |
| `oversample` | `params.quantization.oversampling` | with `rescore`, `oversampling x k` candidates by code score are reread at full precision |

Filtered blocks set `params.acorn: true`, Qdrant's filtered walk, which expands a rejected node's
neighbours in its place; Qdrant applies it below its own selectivity threshold. Exact groups set
`params.exact: true`, Qdrant's brute-force path.

## Facts that are not in the code

- **io_uring.** Qdrant's io_uring rescorer (`async_scorer`) is off by default and stays off here.
  Docker's default seccomp profile denies `io_uring_setup`, so `start` runs the container with
  `seccomp=unconfined`, which lets `async_scorer: true` in `settings.yml` take effect when a
  configuration asks for it.
- **Startup.** Qdrant opens its ports only after every collection is loaded; `check` is a real 1-NN
  search with a zero vector, so startup ends when the engine can search.
- **First filtered query per field.** With `memory: cold` a payload index is read from disk on first
  use. The group's first query, run untimed, pays for it and is recorded as `first_query_s`.
- **Eviction.** Qdrant memory-maps its float vectors (`vector_storage/matrix.dat` in optimized
  segments, `vector_storage/vectors/` in appendable ones); `evict_mapped` names both, so `--evict`
  pages them out of Qdrant's own mappings. Graphs and codes stay in RAM.
- **Timeout.** The client timeout is 3,600 s: an exact query over 247M vectors on disk takes about
  1,000 s.
- **`indexing_threshold=0` parks the optimizer**, and a parked collection reports green with zero
  indexed vectors, so `load` requires `indexed_vectors_count == points_count`.
- **The gRPC stub instead of `query_points`.** `QdrantClient.query_points` turns every returned point
  into a pydantic model: 8.5 ms per query at k=1000 against 2.9 ms through the gRPC stub of the same
  official driver.
- **Upload workers are spawned, not forked**: gRPC does not support forking a process that holds a
  channel.

## Smoke test

`smoke_test.py` needs only a running Qdrant: it builds 40,000 random 32-dimensional rows with the
attribute columns of docs/contracts.md section 2, loads them with `load.py`'s functions, and drives
`client.py` through every group of `queries.json` for `ip` and `l2`, checking that exactly k distinct
ids come back, that every id satisfies the predicate, that exact groups return the true top-k, and
that approximate groups stay above a loose recall floor. About a minute:

```bash
docker run -d --name qdrant-smoke --network host -e QDRANT__SERVICE__HTTP_PORT=6434 \
    -e QDRANT__SERVICE__GRPC_PORT=6433 qdrant/qdrant:v1.20.0
.venv/bin/python qdrant-hnsw-quant/smoke_test.py --port 6434 --grpc-port 6433
docker rm -f qdrant-smoke
```
