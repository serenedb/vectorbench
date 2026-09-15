# VectorBench

A ClickBench-style benchmark of vector search in databases. Every participant publishes, for every
query, the recall/speed curve it measured point by point; the table reads one number per cell off that
curve at the recall the row asks for. Table and graph are two renderings of the same record.

Design: [DESIGN.md](DESIGN.md). Formats every part agrees on: [docs/contracts.md](docs/contracts.md).

## Layout

```
datasets/<family>.yml     dataset families: source, sizes, filter cases, query rows
lib/vectorbench/          the driver: prepare, run, trace, check, assemble
lib/benchmark.sh          thin entry used by every participant's ./benchmark.sh
<participant>/            one directory per database + index family: scripts, queries, settings, client
frontend/                 the results page (React, single-file build), shared with SereneDB Playground
```

Participants so far: `serenedb-ivf`, `serenedb-hnsw`, `qdrant-hnsw`.

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
.venv/bin/python -m vectorbench.cli assemble
(cd frontend && npm ci && npm run build)      # -> frontend/index.html, open it in a browser
```

Useful flags for `run`: `--groups none/10,eq-1/*` to run a subset, `--views latency` for one view,
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
