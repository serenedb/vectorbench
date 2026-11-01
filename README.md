# VectorBench

A ClickBench-style benchmark of vector search in databases. Every participant publishes, for every
query, the recall/speed curve it measured point by point; the table reads one number per cell off that
curve at the recall the row asks for. Table and graph are two renderings of the same record.

Design: [DESIGN.md](DESIGN.md). Formats every part agrees on: [docs/contracts.md](docs/contracts.md).

## Current run: wiki-v3-1024-247m

- **Data:** the whole Cohere `wikipedia-2023-11-embed-multilingual-v3` corpus, 246,838,423 vectors in 323 languages, 1024 dims, inner product. Only the last file of each of the 7 query languages (315,583 rows) stays out, because the 10,000 queries come from there. Exact top-1000 ground truth per filter case.
- **Queries:** k=10, 100 and 1000, unfiltered and for every filter case in `datasets/wiki-v3-1024.yml`, plus the exact eq-1 row (V37) at one client. V04, exact search without a filter, is not run: one query reads about 1 TB of float vectors.
- **Participants:** `serenedb-hnsw-quant` (SereneDB 26.11.1, HNSW) and `qdrant-hnsw-quant` (Qdrant 1.20.0, HNSW), both with 2-bit `tq` codes. One build each: m=16, ef_construction=256, 8 segments (Qdrant ends at 9). Codes and graphs stay in RAM; the 1 TB of float vectors stays on disk uncompressed, so every rescore reads them from EBS. Qdrant keeps its payload indexes on disk and builds no per-value graphs (`payload_m` 0). Its index phase ran with `mmap_advice` sequential and 4 optimization threads, because the defaults ran out of memory, and its load time includes three optimizations redone after the loader gave up during a 10-minute server stall. The second knob differs: Qdrant's `oversample` rescores oversample times k candidates; SereneDB's `width` rescores a candidate while its code score plus width times the code's estimated error could still beat the k-th exact score. Each group's ladder comes from a calibration pass on the same build that brackets recall 0.90, 0.95 and 0.99.
- **Machine:** AWS c7i.24xlarge (96 vCPU, 185 GB RAM), data on EBS (about 560 MB/s, 10K IOPS). Engines are measured one at a time, each after the page cache is dropped, without warmup.
- **Measurement:** 32 clients, every point of each participant's ladder (`settings.yml`) over the 10,000 queries, a pass ending after 60 s; a cell is the participant's Pareto frontier at the row's recall. Points run in ladder order, so a point finds the vectors earlier points read already cached. Latency is read from the same 32-client runs. Startup ends after the first vector query, which loads every segment's graph.

## Layout

```
datasets/<family>.yml     dataset families: source, sizes, filter cases, query rows
lib/vectorbench/          the driver: prepare, run, trace, check, assemble
lib/benchmark.sh          thin entry used by every participant's ./benchmark.sh
<participant>/            one directory per database + index family: scripts, queries, settings, client
frontend/                 the results page (React, single-file build), shared with SereneDB Playground
```

Participants so far: `serenedb-ivf`, `serenedb-hnsw`, `serenedb-hnsw-quant`, `qdrant-hnsw`, `qdrant-hnsw-quant`.

## Run

```bash
uv venv .venv && uv pip install --python .venv/bin/python -e .        # or: pip install -e .
export VECTORBENCH_DATA_DIR=/data/vectorbench                        # prepared corpora live here
export PYTHONPATH=lib

# 1. prepare a dataset size: download, attributes, ground truth per filter case
.venv/bin/python -m vectorbench.cli prepare --dataset sift-128-100k

# 2. run one participant: install, load, then every group in both views
cd serenedb-ivf && VECTORBENCH_DATASET=sift-128-100k ./benchmark.sh --index
#    or, from anywhere:
.venv/bin/python -m vectorbench.cli run --participant serenedb-ivf --dataset sift-128-100k --index

# 3. assemble every participant's results and build the page
.venv/bin/python -m vectorbench.cli assemble    # --dataset wiki-v3-1024-50m: that dataset only
(cd frontend && npm ci && npm run build)      # -> frontend/index.html, open it in a browser
```

Useful flags for `run`: `--groups none/10,eq-1/*` to run a subset (those groups replace their
predecessors in the participant's existing result file, the rest stay), `--views latency` for one view,
`--query-limit 1000 --passes 1 --deadline 8 --budget 8` for development budgets, `--dry-run` to
print the expanded plan, `--label` to keep two builds of one participant side by side,
`--index-set key=value` to override a key of the participant's index settings (for example
`--index-set storage=view --index-set relation=items_vec` on SereneDB). `scripts/dev-run.sh` runs
everything with development budgets.

`vectorbench check --dataset <family>-100k` verifies a participant on a development slice: every
returned id satisfies the predicate, exactly k ids come back, exact rows reach recall 1.000, and the
plan rules hold.

## Adding a participant

Copy `qdrant-hnsw/` or `serenedb-ivf/`, then adjust: `settings.yml` (identity, image, ports, index
parameters and knob ladders per dataset size, plan rules), `queries.sql` or `queries.json` (one block
per group, the engine's own dialect), `client.py` (connect, prepare a group, search), the lifecycle
scripts (`install start stop check load data-size version`), and the README with the "Facts that are
not in the code" section. The contract is in [docs/contracts.md](docs/contracts.md).

## Methodology

See DESIGN.md section 4. In short: participants tune in the open (one index per dataset size, knobs
in the query text, a declared ladder measured point by point); a cell is the crossing of the
participant's own Pareto frontier with the row's recall; two views, 32 clients for throughput and one
client for latency; the engine is restarted before every group and each restart is a startup sample;
load is one timer around the participant's whole recipe.

## License

Apache-2.0. See NOTICE for the benchmarks and datasets this work draws on.
