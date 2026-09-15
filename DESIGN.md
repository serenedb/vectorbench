# VectorBench design

Status: approved 2026-09-14; implementation in progress (driver, SereneDB IVF/HNSW and Qdrant participants, page). Query
lists and recall values in Appendix B are an initial proposal and will be revised per family.

## 1. Goal

A public, reproducible, ClickBench-style benchmark of vector search in databases, with SereneDB as one
participant among others and a results page that SereneDB Playground can host. It is to vector search
what SearchBench is to full-text search.

The one thing vector search adds to an OLAP benchmark is a quality variable: results are approximate,
and every engine trades recall for speed along a curve of its own. Classic ANN benchmarks show only the
curves, which is honest but gives no picture across many queries and engines. ClickBench shows one
number per query and engine, which gives the picture but has no quality variable. VectorBench does
both: every engine publishes its curve for every query, measured point by point, and the table shows
one number per cell, read off that curve at the recall the row asks for. Table and graph are two
renderings of the same complete record.

Participants tune in the open, as in ClickBench: one index per dataset, knobs in the query text, every
point a measurement. What the benchmark adds is the rule for reading the curve, applied identically to
everyone, and the graph behind every row so that a strange ladder of points is visible to any reader.

Two workloads exist in practice and both are shown, separately: search without a filter (the more
common one) and search with a filter. The second is where SereneDB's thesis lives: filtered IVF as
posting-list intersection and filtered HNSW as ACORN-style traversal with a lazily filled bitset, both
fed by the inverted index and the DuckDB columnstore, against engines that pre-filter with a bitmap or
post-filter an unfiltered candidate list.

Inspiration, not code to port: ClickBench (runner shape, tuning rules, relative coloring, geomean
ranking), SearchBench (adapter contract, results JSON per engine, React frontend shared with
Playground), the colleague's `searchbench-dev` vector track (methodology lessons, engine facts,
ground-truth pipeline), ann-benchmarks and big-ann (frontier reading, recall definition, datasets),
Qdrant's filtering datasets and VectorDBBench (filter selectivity ladders), the ACORN paper
(query-correlated predicates).

Non-goals for v1: streaming inserts under load, capacity tests, GPU, multi-node, sparse vectors,
cold-cache measurements (see 4.4), complex predicates (see 3.3).

## 2. The benchmark in one screen

```
wiki-v3-1024 [10m v]        view (Throughput: 32 clients, QPS) | Latency: 1 client        cells (relative) | absolute
chips:  [none] [eq] [range] [and] [corr] [xcorr]    [k=10] [k=100] [k=1000]    [0.90] [0.95] [0.99] [exact]

GENERAL                                SereneDB IVF   Qdrant HNSW   SereneDB HNSW   pgvector HNSW   Elastic HNSW
load time (s)                              812           1530           812            2100            4400
on disk (GB)                                22             35            31              58              61
max memory during load (GB)                 41             50            55              90              64
startup (s)                                1.2            4.1           3.4             0.8              31
-----------------------------------------------------------------------------------------------------------
NO FILTER
max memory during queries (GB)               9             28            26              41              30
score (geomean, visible rows)            x1.00           x1.3          x1.4            x4.1            x5.3
coverage                                 10/10          10/10         10/10            9/10            8/10
V01  k=10     recall 0.90               24100          31000         35000            9800            6100
V02  k=10     recall 0.95               18400          27500         31000            7900            4900
V03  k=10     recall 0.99                6100           8900          9800            1200       reached 0.97
V04  k=10     exact                       410            380           410              95       reached 0.97
...
-----------------------------------------------------------------------------------------------------------
FILTERED
max memory during queries (GB)              11             30           unsupported     44              31
score (geomean, visible rows)            x1.00           x1.4          x                x3.9            x2.2
coverage                                 27/27          27/27          0/27           25/27           24/27
V11  eq-10   k=10   recall 0.95         17900          21000    unsupported            7100            5200
V12  eq-1    k=10   recall 0.95         17200           9800    unsupported            2100            4900
V13  eq-0.1  k=10   recall 0.95         20100           1900    unsupported             610            4300
...
```

- Every cell is colored ClickBench-style: green at the row's best, fading to red as the ratio grows.
  Grey cells are failed: `reached 0.97` (curve does not reach the row's recall), `unsupported`
  (query id missing from the engine's file), `error`, `bracket too wide` (density rule), `n/a`
  (degenerate at this size).
- **Click a row**: a half-height graph opens under it, x recall, y the current metric on a log axis,
  one line per engine through its measured points, the vertical line at the row's recall, every
  crossing marked. A button expands it to full screen where more rows can be added as lines. Rows that
  share filter case and k share the same points.
- **Click a cell**: everything measured for that engine on that query: every point with all statistics,
  knob values and the statement that ran, the two points bracketing the row's recall and the crossing,
  memory peak, startup. Later: explain and explain-analyze output, as SearchBench shows.
- **Click a header row**: load phases bar; on-disk info list; startup statistics.

Vocabulary:

| term | meaning |
|---|---|
| **dataset family** | corpus with fixed dimension, metric and attribute columns, e.g. `wiki-v3-1024` |
| **size** | a prefix of the family: `100k` (development only), `1m`, `10m`, `100m`, full |
| **query** (row) | (filter case, k, recall) with an id and tags, defined per family, identical for all sizes; `exact` is a recall value meaning brute force |
| **group** | the rows sharing (filter case, k); they share one set of points per engine |
| **participant** | a database plus an index family, e.g. `SereneDB IVF`; one index per dataset size, tuned in the open |
| **view** | the load condition: Throughput (32 clients) or Latency (1 client) |
| **point** | one knob setting of a participant on a group, measured in full in one view |
| **curve** | the participant's Pareto frontier through its own points, linear in recall and log metric |
| **crossing** | where the curve meets the row's recall; the cell value |
| **section** | GENERAL, NO FILTER, FILTERED |

## 3. Datasets and queries

### 3.1 Corpora

Dataset ids are `<family>-<size>`. The small size is a prefix of the large size (first N rows of the
same shard sequence), so downloading a small size is a partial download, and the query set is the same
for every size.

| family | modality, model | dims | dtype | metric | real attributes | queries and official ground truth |
|---|---|---|---|---|---|---|
| `sift-128` | image, SIFT descriptors (big-ann BIGANN) | 128 | uint8 | l2 | none | 10K official queries; official GT at 10M/100M (depth 100), used for validation |
| `dino-1024` | image, DINOv2 (big-ann `dino`) | 1024 | uint8 | l2 | none | official queries (bvecs); official GT only at 100M |
| `wiki-v3-1024` | text, Cohere embed-multilingual-v3 (HF `Cohere/wikipedia-2023-11-embed-multilingual-v3`, en+de+fr+es+ru+ja+zh round-robin over language shards) | 1024 | float32 | ip (unit-normalized: `prepare` measured norm 1.0 on every row, so ip = cosine) | lang, title | 10K held out from the tail of each language shard, beyond the largest prefix |
| `dbpedia-3072` | text, OpenAI text-embedding-3-large (HF `Qdrant/dbpedia-entities-openai3-text-embedding-3-large-3072-1M`) | 3072 | float32 | ip (unit-normalized) | title | 10K held out from the tail |
| fifth family, decided before the large runs | MS MARCO Web Search (Microsoft, 768-d, 100M documents, real query embeddings, official GT, O-UDA licence) or big-ann `caselaw` (OpenAI 1536-d, 7.4M, official queries and GT). Recommendation: MS MARCO Web Search | 768 / 1536 | float32 | ip | none | official |

Sizes per family. Rule: at most two families whose load takes multiple hours (more than about 100 GB
of float32 vectors per engine copy). Many families at small sizes are cheap but add little beyond one
per distribution family, so the roster stays at five.

| family | 100k (dev) | 1m | 10m | 100m | full | float32 bytes at the largest tier |
|---|---|---|---|---|---|---|
| `wiki-v3-1024` (text flagship) | yes | yes | yes | yes | 247M | 1.0 TB |
| `dino-1024` (image flagship) | | yes | yes | yes | | 410 GB |
| `sift-128` (classic reference) | yes | yes | yes | yes, cheap at 51 GB | | 51 GB |
| `dbpedia-3072` | | yes | none, 1M is the corpus | | | 12 GB |
| fifth family | | yes | yes | | | 31 GB / 45 GB |

Why these: two image families bracket the small dimensions with the classic descriptor workload
(`sift`) and a modern image embedding (`dino`); `wiki-v3` is the multilingual text workload with a real
correlated attribute, and the largest open modern text set; `dbpedia` is
the only 3072-d set and lacks a large size because no public 3072-d corpus above 1M exists; the fifth
family brings real queries with official ground truth. Later: `yfcc-192` (big-ann filter track, 10M
CLIP vectors with real tags) and `text2image-200` (out-of-distribution queries). Uint8 corpora are
loaded as float32 in every engine so all engines carry the same bytes per vector; byte or int8 storage
is the participant's choice.

Development uses `sift-128-100k` and `wiki-v3-1024-100k`, then every family at `1m`. The `10m`,
`100m` and full sizes are a separate activity once the benchmark exists (section 9, track B). The page
leads with the two flagships; the other families exist for distribution diversity and adapter
correctness (different dims, dtypes and engine caps).

Metric is not an axis. Each family is searched under its native metric, the one its embeddings were
trained for and its ground truth is defined with: l2 for descriptor and image sets, ip or cosine for
text embeddings. Cosine is normalization at insert plus ip at search, so a family is never run under
both; `prepare` records the norm distribution so the choice is explicit. Metric changes the algorithm
less than the data distribution does, which is why families are chosen for distribution diversity. l1
is out of scope.

### 3.2 Attributes

Every row carries the same attribute columns, stored in the base shards next to the vector so each
engine ingests them in one pass. Synthetic columns are a pure function of the row id (splitmix64), so
every engine, every size and every language mix sees identical values without a lookup table:

| column | type | values | used by |
|---|---|---|---|
| `cat10` | int16 | uniform 0..9 | `eq-10` (selectivity 10%) |
| `cat100` | int16 | uniform 0..99 | `eq-1` |
| `cat1000` | int16 | uniform 0..999 | `eq-0.1` |
| `num` | int32 | uniform 0..999,999 | `range-10`, `range-1`, `and-1` |
| `ts` | timestamp | monotone in id (one row per second from 2020-01-01) | reserved for a clustered range case |
| `cluster` | int16 | k-means cluster id of the row's own vector (100 clusters, centroids trained once on the 1M prefix with a fixed seed and published, so ids are identical across sizes) | `corr`, `xcorr` |
| `tags` | list<string> | 3 tags per row from a Zipf vocabulary of 10K tokens (extended tier, later) | `tag-*` |
| `lang` | string | real language code (wiki only) | family-specific queries |
| `title` | string | real (wiki, dbpedia) | later |

`cluster` exists so every family, not only Wikipedia, has a predicate correlated with the vector: a
query's nearest neighbours mostly share its cluster (positive correlation), and a filter on a distant
cluster is the adversarial case.

### 3.3 Filter cases

Core tier, v1, expressible in every engine:

| case | predicate | selectivity | what it shows |
|---|---|---|---|
| `none` | | 100% | plain ANN |
| `eq-10` / `eq-1` / `eq-0.1` | `cat10 = v` / `cat100 = v` / `cat1000 = v` | 10 / 1 / 0.1% | selectivity ladder, uncorrelated with the vector; at 0.1% pre-filtering wins, at 10% graph traversal should (ACORN threshold about 1/gamma) |
| `range-10` / `range-1` | `num BETWEEN lo AND hi` | 10 / 1% | range predicate, second index type |
| `and-1` | `cat10 = v AND num BETWEEN lo AND hi` (10% x 10%) | 1% | conjunction of two indexes, where posting intersection is the natural plan |
| `corr` | `cluster = cluster of the query vector` | about 1% | positively correlated: the realistic "same topic" case |
| `xcorr` | `cluster = a cluster far from the query` | about 1% | negatively correlated: post-filtering collapses, bitmap pre-filter and ACORN keep recall |

Per query the argument is derived from the query id, so each case has the stated selectivity on
average and different queries hit different values. Engines return exactly k ids; a result with fewer
ids is scored as-is, so post-filter shortfall shows up as lost recall.

Extended tier, later, tests predicate breadth and the planner; engines that cannot express a predicate
get `unsupported`: `or-2` (`cat100 = a OR cat100 = b`), `in-1` (`cat1000 IN (10 values)`), `not-90`
(`cat10 <> v`), `nested-1`, `tag-1` / `tag-0.1` / `tag-and` on the `tags` array (the big-ann filter
track shape), `prefix` on title, and regex (indexable in SereneDB, a scan in most others). Free-text
match on real titles is kept out until tokenizers are pinned, because a recall loss could be a stemming
difference rather than a search difference.

### 3.4 Queries

A query is (filter case, k, recall) with a stable id and tags, defined per dataset family and identical
for every size of the family. Most of the list is shared by all families because the synthetic
attributes exist everywhere; a family adds queries only for attributes it alone has (a language filter
on Wikipedia, real tags on YFCC later) and drops nothing.

- **k** in 10, 100, 1000. k=10 is the classic ANN regime, k=100 the RAG re-ranking regime, k=1000 the
  candidate-generation regime where the result heap, the exact re-ranking of `rerank_factor * k` raw
  vectors and shipping 1000 ids per query dominate. Large k is where the phase-2 rerank rework should
  show most.
- **Recall** is the value at which the row reads each engine's curve. Which recall values exist is a
  per-family decision written in the query list: 0.90 / 0.95 / 0.99 is the default set; an easy
  descriptor family may use 0.95 / 0.99 / 0.999, a hard one 0.80 / 0.90 / 0.95; some values exist only
  for some k. There is no default recall and no selector: every row says which recall it is. The
  no-filter section carries more recall variety than the filtered one, because that is where
  quantization and rerank trade-offs show.
- **`exact`** rows read the brute-force point (recall 1.0). They anchor the scale ("IVF is 40x brute
  force here") and double as the id-mapping test.
- **Degenerate** rows, fewer than 10 k rows matching the predicate at a given size (eq-0.1 at k=1000
  on 1m), are n/a for that size and excluded from scores.
- **Unsupported** is a missing group in a participant's query file. It counts as failed for coverage.

Appendix B holds the initial list.

### 3.5 Ground truth and recall

- 10,000 queries per family, the same set for every size. Official query files are used where the
  publisher ships them (`sift`, `dino`, fifth family); HF corpora hold out the tail of each language
  shard beyond the largest prefix, so a query is never its own neighbour at any size. At 100M and above
  the first 1,000 queries are used.
- Ground truth: exact top-1000 ids and distances per query, per size and per filter case, computed by
  chunked float32 BLAS over base shards with a boolean mask per case, in worker processes with a fixed
  BLAS thread budget; per-chunk `argpartition` to 1000 then a merge across chunks. Cost at 10M x 10K x
  1024 is about 2e14 flops per case, minutes per case on this host; 80 MB per case at depth 1000.
  Validated against the official big-ann files for the `none` case of `sift-128-10m` (depth 100 prefix
  must match exactly).
- **Recall** of a point is the mean over the query set of tie-aware recall@k: a returned id counts if
  its true distance is at most the k-th ground-truth distance plus 1e-6 (big-ann's definition). Integer
  SIFT and quantized indexes tie constantly; strict id matching would punish correct answers. The strict
  value is stored too, as is the **tail**: the share of queries with recall below 0.5, which exposes
  filtered searches that return nothing while the mean still looks acceptable.
- Recall carries sampling noise of a few thousandths on 10K queries, and HNSW construction is not
  deterministic. The methodology says so.
- Prepared data (`base/` shards with attributes, `queries.parquet` with per-case arguments,
  `gt/<case>.npz`, `centroids.npy`, `manifest.json` with dims, metric, norm statistics, attribute and
  query specs, sha256 per file) is published to a public bucket, so users download instead of running
  the HF download or the BLAS step.

## 4. Methodology (the README section, in rules)

### 4.1 Participants tune in the open

1. A participant is a database plus an index family (`SereneDB IVF`, `SereneDB HNSW`, `pgvector HNSW`,
   `Qdrant HNSW`, `Elasticsearch HNSW`). Variants are separate participants, like ClickBench's plain and
   tuned entries; maintainers keep them few.
2. One index configuration per participant per dataset size, public in the engine directory. Index type,
   quantization, m, ef_construction, posting size are the participant's means, never the benchmark's
   axes.
3. For every group (filter case, k) the participant declares a **ladder** of knob settings, about seven
   points spanning the recalls its rows ask for. Knobs are variables in the query text and the ladder
   lives in a settings file next to it, per dataset size:
   `SET sdb_ivf_search_nprobe = {nprobe}; SELECT id FROM items WHERE cat100 = $v ORDER BY emb <#> $q LIMIT 10;`
   with `nprobe: [4, 8, 12, 16, 24, 32, 48, 64]`. Every setting is measured; the reader sees exactly what
   ran at every point.
4. The engine owns the data: `load` copies rows into the engine's storage and `data-size` counts them.
   An index over the external parquet files is not allowed, because load time and on-disk size are
   published metrics.

### 4.2 Points, curves, crossings

5. **A point is a measurement.** Client round-trip timing per query, after connection setup and after
   knobs are applied, including parsing the k returned ids. The client is the engine's official Python
   driver over its fastest protocol (psycopg binary, Qdrant gRPC, Elasticsearch HTTP with orjson).
6. **Concurrency is processes, not threads.** N client processes, one connection each, a shared start
   barrier, per-query timestamps shipped back to the coordinator. Clients run on CPUs outside the
   engine's cpuset. Two views: Latency at 1 client, Throughput at 32 clients (the tier's CPU count).
7. **Passes.** Warm-up of 100 queries per client, then passes over the query set in fixed order with a
   per-client offset. A pass ends when the set is exhausted or after 60 s, but not before 2,000 queries;
   passes repeat until three are done or 60 s have elapsed in total. All passes are stored; the headline
   is the best pass (ClickBench convention); recall is taken from the first pass. Engine result caches
   are disabled where they exist.
8. **Every distribution is reported the same way:** n, min, avg, p50, p95, p99, max. Per point that is
   the latency distribution; QPS is queries completed over wall time across clients (by Little's law
   about clients / avg; the gap to that shows client overhead and stragglers).
9. **Curve** = the participant's Pareto frontier through its own points for a group and view, linear in
   recall and log metric. Dominated points (another point has both higher recall and better metric) are
   drawn hollow and ignored; filtered searches produce such points and this neutralizes them.
10. **Cell** = the crossing of the curve with the row's recall: log-linear interpolation between the two
    neighbouring points. When a point lies within a few thousandths of the row's recall, the crossing
    is that measurement in all but name. The graph draws the vertical line and marks every crossing, so
    the table cell and the graph show the same thing.
11. **Density rule.** The two points bracketing a row's recall must be within 0.02 recall of each other
    or be adjacent values of an integer knob, otherwise the cell fails as `bracket too wide`. This keeps
    the reading honest for everyone and makes an asymmetric ladder pointless. On the usual curve, where
    QPS falls faster and faster as recall approaches one, the chord lies under the curve, so a sparse
    ladder only hurts its owner.
12. **Not reached**: the curve's highest recall is below the row's, the cell reads `reached 0.97`, grey,
    failed. **Only above**: every point is above the row's recall, the cell takes the lowest-recall
    point, conservative and visible on the graph as a curve starting right of the line.
13. **Exact rows** take the brute-force point's metric directly.

### 4.3 Per dataset size: load, disk, memory, startup

14. **One load timer.** Load time is the wall time of the participant's `load` script, from empty engine
    to exit. The participant owns the recipe: ingest then build, index while ingesting, force merge,
    compaction, VACUUM, ANALYZE. All of it is inside the timer, so consolidation bought with time is a
    visible trade-off. `load` exits only when settled: no pending indexing or compaction, index at full
    quality, state persisted. `load` may print `VECTORBENCH_PHASES={"ingest": 312.4, "index": 501.0,
    "compaction": 88.2}` (seconds, free keys), shown as a stacked bar in the load-time detail with any
    remainder as "other", and `VECTORBENCH_INFO={"segments": 12, "index_bytes": 22e9, ...}` (free
    form), shown in the on-disk detail.
15. **On disk** is `data-size` right after `load`. **Memory peaks** are read from the container cgroup
    (`memory.peak`, reset before each phase): once for the load phase (GENERAL section), once over the
    no-filter groups and once over the filtered groups (each section's first row), and per point in the
    cell detail. A participant that is OOM-killed or refuses to load under the tier's cap records
    "does not fit" for that size.
16. **Startup.** The engine is restarted before every group in every view. Each restart is a startup
    sample: from invoking `start` to the first successful `check`, polled every 100 ms. Stop is always
    graceful, so this is a normal restart, not crash recovery. About 54 restarts per dataset size give
    a real distribution, shown as avg in the header and with all statistics in the detail. `start` must
    not hide loading behind its own waiting loop and `check` must be a real readiness probe; for engines
    that need an explicit collection load before they can search, that load belongs inside `start`.

### 4.4 Not measured in v1

17. **Cold cache.** Restart before every group already gives cold-process behaviour through startup and
    warm-up; a page-cache drop needs root or passwordless sudo and its result is hard to interpret for a
    query set. Dropped, so the benchmark needs no privileges anywhere. A disk-resident tier (memory cap
    below index size) may come later as an extra tier.

### 4.5 Scores and hardware

18. **Two scores**, NO FILTER and FILTERED, each ClickBench's geomean of per-row ratios to the row's best
    participant, with smoothing, over the rows currently visible (chips recompute it, as SearchBench
    does), coverage first. Columns sort by the no-filter score by default; clicking the filtered score
    re-sorts. No overall score.
19. **One host, capped engine.** Engine container under `--cpuset-cpus` and `--memory` (swap disabled),
    clients outside the cpuset. The tier (cpus, memory, storage class, host model) is recorded in every
    result and shown on the page. Default published tier: 32 CPUs, 64 GiB.
20. **Every knob is a flag** and every flag is recorded in the result. Environment variables are
    accepted only as defaults for `VECTORBENCH_DATA_DIR` and `VECTORBENCH_DATASET`.

## 5. Engine adapter contract

SearchBench's script contract plus per-engine query files and a thin in-process client for the hot
loop, because thousands of queries per second cannot pay a process spawn per query.

```
<participant>/                       # e.g. serenedb-ivf/
  benchmark.sh          # exports ENGINE_NAME, ENGINE_TAGS; exec ../lib/benchmark.sh "$@"
  install start stop check version load data-size     # SearchBench semantics; load = whole recipe, prints the two tags
  queries.sql | queries.json          # one statement per group (filter case, k); $q $k and filter args bound per query, {knob} variables
  settings.yml          # per dataset size: index parameters and the knob ladder per group (a default plus overrides)
  client.py             # class Client: connect(), run(statement, params) -> ids; about fifty lines
  create.sql | schema.json | mapping.json             # DDL or collection config, plain files
  README.md             # image, prerequisites, index config, "Facts that are not in the code", version history
  results/              # <participant>_<family>-<size>.json
```

```yaml
# settings.yml (excerpt)
wiki-v3-1024:
  1m:  {index: {quant: sq8, posting_size: 1024}, ladder: {nprobe: [2, 4, 8, 12, 16, 24, 32, 48]}}
  10m: {index: {quant: sq8, posting_size: 1024}, ladder: {nprobe: [4, 8, 12, 16, 24, 32, 48, 64, 96]},
        groups: {"eq-0.1/*": {ladder: {nprobe: [8, 16, 32, 64, 128, 256]}}}}
```

- The benchmark defines the queries (id, meaning, arguments per query vector, k, recall) in the dataset
  family definition; ground truth is computed from that definition. The participant expresses each
  group in its own dialect, exactly like a ClickBench `queries.sql`. No translator.
- The driver checks every participant on the 100k slice: all returned ids satisfy the predicate
  (evaluated over the attribute columns in pandas), exactly k ids come back, the `exact` statement
  reaches recall 1.000. At larger sizes the predicate check runs on a 1% sample of queries.
- `unsupported` is a missing group in the query file.

Engine facts to preserve from the colleague's adapters and SearchBench:

| engine | image / driver | notes |
|---|---|---|
| SereneDB | `serenedb/serenedb:<tag>`; `install` pulls only if the tag is not local, so a custom build is `docker build`/`docker load` under that tag; a second participant directory or a `--version <label>` keeps two SereneDB builds side by side (needed for phase 2) | see 5.1; the shipped docs are stale (no HNSW, old `sdb_nprobe`, removed `nlist`), the adapter follows the code on main |
| Qdrant | official image, `qdrant-client` over gRPC | `indexing_threshold=0` during upload then raise it; pin `default_segment_number` (else recall depends on host CPU count); `full_scan_threshold=10`; settled = 3 consecutive GREEN with idle optimizers; payload indexes on the attribute fields; `hnsw_ef` is max(hnsw_ef, limit) so k=1000 is fine; the io_uring async scorer needs `seccomp=unconfined`, record whether it was effective |
| pgvector | `postgres:18` + pgvector 0.8.x built with `-march=native`; psycopg binary COPY | `maintenance_work_mem` and `max_parallel_maintenance_workers` sized for the HNSW build; `hnsw.ef_search` has a hard maximum of 1000, so k=1000 needs `hnsw.iterative_scan = relaxed_order` with `hnsw.max_scan_tuples` raised; iterative scan also for filtered queries; btree indexes on attributes; `halfvec` for 3072 (vector is capped at 2000 dims); reuse SearchBench's `lib/pg-tuning.sh` pattern |
| Elasticsearch | official image 9.x, `elasticsearch-py` + orjson | `dense_vector` with `hnsw` / `int8_hnsw` / `bbq_hnsw`; `_source` excludes the vector; shards, not client threads, are the ingest lever (about 12,600 rows/s at 1024 dims with 16 shards); `num_candidates` is per shard and capped at 10,000, which bounds k=1000 at 10 x k; `knn` with `filter` (Lucene pre-filtering) and `rescore_vector.oversample`; request cache off; force merge inside `load`; heap = 1/4 of the memory cap; `vm.max_map_count` prerequisite |

Later: OpenSearch (faiss engine, explicit `ef_search`, `index_thread_qty`, `approximate_threshold=0`),
Milvus (HNSW / IVF_* / RABITQ; collection load inside `start`), Weaviate (eager HNSW load at startup),
ClickHouse (vector similarity index), LanceDB (embedded; shared `Session` cache or it OOMs at many
clients).

### 5.1 SereneDB participants (from the code on main, 2026-09-14)

```sql
CREATE TABLE items (id BIGINT, cat10 SMALLINT, cat100 SMALLINT, cat1000 SMALLINT, num INTEGER,
                    ts TIMESTAMP, cluster SMALLINT, lang TEXT, title TEXT, emb FLOAT[1024])
  WITH (storage = 'search', compaction_interval = 0);           -- rows live in the index, like SearchBench 26.09
-- one participant, one index; metric = 'ip' or 'l2' from the family manifest:
CREATE INDEX items_ivf  ON items USING inverted(id, cat10, cat100, cat1000, num, cluster, lang,
                                                 emb ivf  (metric = 'ip', quant = 'sq8'));          -- SereneDB IVF
CREATE INDEX items_hnsw ON items USING inverted(id, cat10, cat100, cat1000, num, cluster, lang,
                                                 emb hnsw (metric = 'ip', quant = 'sq8', m = 32, ef_construction = 200));  -- SereneDB HNSW
INSERT INTO items SELECT ... FROM read_parquet([...]);           -- corpus dir is identity-mounted read-only
VACUUM (REFRESH_TABLE items); VACUUM (COMPACT_TABLE items);      -- then wait until compaction is idle and num_segments is stable
```

- Vector column is `FLOAT[N]` only (no half precision); ceiling 32768 dims. Operators: `<->` l2,
  `<=>` cosine, `<#>` ip; the index is used only when the operator's metric equals the index metric,
  otherwise the planner silently falls back to a scan (EXPLAIN must show `IRESEARCH_SCAN` with `Score:`
  and `Top:` lines).
- Attribute columns are index key columns so a predicate is answered by the inverted index; EXPLAIN
  shows it inside the scan as `Index Filter:`. The adapter asserts that once per size on the 100k slice.
- `ivf` options: `metric` (required), `quant` in none/sq8/sq4/pq/rabitq/tq, `pq_m`, `nb_bits`,
  `compression`. `hnsw` options: `metric`, `quant` in none/sq8/sq4/tq, `m` (32), `ef_construction`
  (200), `compression`. Build-time GUCs, set before CREATE INDEX: `sdb_ivf_posting_size` (1024),
  `sdb_ivf_sample_factor` (0.2). There is no `nlist`; cluster count is about rows / posting_size.
- Search knobs (session GUCs, in the query text): `sdb_ivf_search_nprobe` (8),
  `sdb_ivf_max_search_fanout` (16), `sdb_hnsw_ef_search` (64; also the result ceiling, so ef >= k),
  `sdb_rerank_factor` (4.0; exact-rescoring pool = factor * k for quantized indexes, 4,000 raw vector
  reads per query at k=1000; 0 disables). The phase-2 rerank rework changes what this knob costs.
- `exact` rows: `sdb_disable_top_k_optimization = true` on an unquantized index, the streaming
  brute-force path the engine's own tests use as oracle.
- **HNSW refuses filtered search today** (`ERRCODE_FEATURE_NOT_SUPPORTED`, "use an ivf vector index
  instead"), so the SereneDB HNSW participant has no filtered groups in its query file until phase 2
  lands filtered HNSW, and its FILTERED section reads `unsupported`. The benchmark measures the gap
  rather than hiding it.
- Everything is per segment (graph, centroid tree, rerank), so recall and latency depend on segment
  count; `load` compacts and waits for `compaction_active = compaction_pending = 0` and a stable
  `num_segments`, and reports `num_segments` in the INFO tag. Index bytes = `sdb_metrics.index_size`
  (pg_indexes_size returns 0). Build progress: `pg_stat_progress_create_index`.
- Memory: HNSW loads graph and codes per segment into process memory on first touch, outside
  `memory_limit`; the container cap is what bounds it. Process flags in `serened.conf`:
  `--cpu_threads`, `--background_threads`, `--io_threads`, `--server_directory`, `--listen`.
- IVF build is single-threaded per segment, HNSW build fans out to 64 workers: load time comparisons
  must state `num_segments` and the CPU cap.
- Images: `serenedb/serenedb:MAJOR.MINOR.PATCH` on Docker Hub. Local builds: CMake preset `bench`
  (Release, static, jemalloc), clang-21, `ninja -C build_bench`, tens of minutes on this host.

## 6. Driver and result format

`lib/` holds a Python package `vectorbench` with subcommands:

- `prepare --family X --size S` (download, prefix slicing, attributes, holdout, ground truth per size
  and case, manifest, upload)
- `run` (one participant on one dataset size: `--index` to install, start and load; then for every
  group and view: restart, startup sample, check, warm-up, every ladder point measured; `--groups`,
  `--views`, `--dry-run` prints the expanded points)
- `trace --group eq-1/10 --knob nprobe=4,8,16,32,64` (quick recall and QPS at 1 client on 1,000
  queries, for designing ladders; output under `<participant>/trace/`, git-ignored)
- `check` (predicate verification, k-count and exact-recall test on the 100k slice)
- `assemble` (`*/results/*.json` plus each family's query list into `frontend/results.json`, like
  SearchBench's `build_results`)

`lib/benchmark.sh` is a thin bash entry so `cd serenedb-ivf && VECTORBENCH_DATA_DIR=... ./benchmark.sh
--index` reads like SearchBench. Results are written atomically to `.partial.json` after every point
and promoted at the end. The stored record is **points**; rows, crossings, scores and coverage are
derived on the page from the family's query list, so table and graph can never disagree. One file per
participant per dataset size:

```json
{
  "participant": "SereneDB IVF", "system": "SereneDB", "family": "ivf", "version": "26.09.0", "label": null,
  "os": "Ubuntu 24.04", "date": "2026-10-01", "dataset": "wiki-v3-1024-10m", "tags": ["C++", "SereneDB"],
  "hardware": {"cpus": 32, "cpuset": "0-31", "memory_bytes": 68719476736, "storage": "nvme", "host": "AWS ..., 96 vCPU"},
  "load_time": 812.4, "load_phases": {"ingest": 312.4, "index": 501.0, "compaction": 88.2},
  "disk_bytes": 22000000000, "disk_info": {"segments": 12, "index_bytes": 22000000000},
  "memory_peak": {"load": 41000000000, "unfiltered": 9000000000, "filtered": 11000000000},
  "startup": {"n": 54, "min": 0.9, "avg": 1.2, "p50": 1.1, "p95": 1.9, "p99": 2.3, "max": 2.4},
  "index": {"ddl": "CREATE INDEX ... ivf (metric='ip', quant='sq8')", "params": {"quant": "sq8", "posting_size": 1024}},
  "groups": [
    {"filter": "eq-1", "k": 10, "view": "throughput", "clients": 32, "status": "ok",
     "statement": "SET sdb_ivf_search_nprobe = {nprobe}; SELECT id FROM items WHERE cat100 = $v ORDER BY emb <#> $q LIMIT 10",
     "startup": 1.15, "memory_peak": 8700000000,
     "points": [
       {"knobs": {"nprobe": 8},  "recall": 0.902, "recall_strict": 0.897, "tail": 0.003,
        "qps": 24100.0, "latency": {"n": 96400, "min": 0.6, "avg": 1.33, "p50": 1.2, "p95": 2.1, "p99": 3.4, "max": 15.0},
        "passes": [{"qps": 24100.0, "p50": 1.2, "p99": 3.4}, {"qps": 23800.0, "p50": 1.2, "p99": 3.6}]},
       {"knobs": {"nprobe": 12}, "recall": 0.931, "...": "..."},
       {"knobs": {"nprobe": 16}, "recall": 0.957, "...": "..."}
     ]},
    {"filter": "eq-1", "k": 10, "view": "latency", "clients": 1, "status": "ok", "points": ["..."]},
    {"filter": "xcorr", "k": 1000, "view": "throughput", "status": "n/a", "reason": "degenerate: 9800 matching rows < 10k"},
    {"filter": "range-1", "k": 10, "view": "throughput", "status": "unsupported"}
  ]
}
```

`exact` is a group of its own with one point. Raw per-query latencies and returned ids are kept locally
as `.npz` sidecars (not committed) for re-scoring.

## 7. Results page

Clone the SearchBench frontend architecture: `@vectorbench/frontend` exporting `ProductApp`, `path`,
`serviceId`; results injected with `provideResults()` before import; `deps/serene-design` submodule;
`scripts/build.mjs` producing one self-contained `frontend/index.html`; the offline Playwright test and
the assembler test; the URL-state codec. The row model transfers directly: SearchBench rows are "queries
with tags by engines", ours are queries with tags by participants; the per-cell value is computed from
the participant's points rather than read from a latency triple.

- Selectors: dataset family and size (default: the largest size every participant has completed),
  view (Throughput default, Latency), cells (relative default, absolute), y metric for the graph and
  the Latency view (QPS, avg, min, p50, p95, p99, max).
- Chips filter rows by tag: filter case, k, recall, exact. Scores and coverage recompute over visible
  rows.
- Three sections as in section 2: GENERAL (load time, on disk, max memory during load, startup),
  NO FILTER and FILTERED (max memory during queries, score, coverage, rows). Rows are queries, columns
  participants, cells colored by ratio to the row's best, failed cells grey with the reason on hover.
- Row click: half-height graph, expandable; cell click: full detail; header click: phases bar, info
  list, startup statistics. Later: explain and explain-analyze in the cell detail.
- Crossing, frontier, density check, scores and coverage are computed in the frontend from points and
  the query list, and unit-tested there.

Reuse by copying from `searchbench/frontend`: `entities/results/model/source.ts`,
`shared/lib/{scale,format,color,url-codec,metrics,ranking}.ts`, `shared/ui/*`, `widgets/results-table/*`,
`widgets/charts/HBars.tsx`, `widgets/query-panel/*` (as the detail pattern), `scripts/build.mjs`,
`tests/*.test.mjs`, `build_results` skeleton, `standalone.tsx` wiring.

## 8. Repository layout

```
vectorbench/
  README.md LICENSE NOTICE            # NOTICE: ClickBench (runner pattern, no code), ann-benchmarks and big-ann
                                      # (frontier reading, recall definition, datasets), Qdrant filtering datasets and
                                      # VectorDBBench (filter ladders, ideas only), dataset publishers and their licences
  DESIGN.md                           # this file, later folded into README "Methodology"
  lib/
    benchmark.sh                      # thin entry
    requirements.txt                  # numpy, pyarrow, pyyaml, psycopg[binary], qdrant-client, elasticsearch, orjson, huggingface_hub
    vectorbench/                      # driver package: datasets/ prepare/ groundtruth/ runner/ metrics/ results/ cli.py
  datasets/<family>.yml               # source, dims, metric, sizes, attribute spec, filter cases, query list with recalls, published URLs
  serenedb-ivf/ serenedb-hnsw/ qdrant-hnsw/ pgvector-hnsw/ elastic-hnsw/     # v1 participants
  frontend/                           # React product + deps/serene-design submodule
```

## 9. Implementation phases

Two tracks. Track A builds the benchmark on the development slices and the `1m` sizes; track B runs
the large sizes and is an operational activity that starts only when track A is usable.

### Track A: develop the benchmark

| phase | deliverable | done when |
|---|---|---|
| A0 skeleton | repo layout, README/NOTICE drafts, `lib/vectorbench` package, family yml with the query list, `prepare` for `sift-128-100k` and `wiki-v3-1024-100k` (download, prefix slicing, attributes, holdout, ground truth for all cases), unit tests for attributes, ground truth, recall, frontier and crossing | `prepare` produces both development slices locally; GT matches a naive numpy check on 10K rows and the official sift ground truth on the `none` case |
| A1 driver + SereneDB | `run` with restart per group, startup sampling, ladders, passes, both views, `--dry-run`; `trace`; `check`; SereneDB IVF and SereneDB HNSW participants end to end; result JSON | full 100k run for both SereneDB participants; `exact` at recall 1.000; predicate check passes |
| A2 Qdrant + pgvector | two more participants; memory peaks per section; tiers; `assemble` | 100k run on four participants |
| A3 frontend | cloned frontend with sections, rows from points, graph under rows, details, tests | `index.html` renders the 100k results offline |
| A4 1m tier | `prepare` for all families at `1m`; publish prepared data to the bucket; Elasticsearch participant; first published runs of all participants at `1m` | results committed, page live |
| A5 breadth | OpenSearch, Milvus, Weaviate, ClickHouse; extended filter tier; explain in the cell detail | |

Phase 2 of the overall project (SereneDB rerank rework, filtered HNSW, Qdrant-parity work) starts once
A1 exists, because A1 is what measures it: a custom `serened` image under its own participant
directory or version label shows up as its own column.

### Track B: large runs (separate activity)

- Order: `10m` for all families, then `100m` for `wiki-v3`, `dino` and `sift`, then full `wiki-v3`
  (247M).
- Budget per participant at the top tiers: about a day of machine time each for load plus the run
  (SereneDB indexed the full Cohere corpus in under 8 hours in the colleague's setup; whether that
  included a table copy is to be confirmed; Elasticsearch ingests about 5.5 hours for 247M before
  merges; pgvector HNSW does not fit its build into memory at this size and is expected to record
  "does not fit").
- Disk on this host: prepared corpus 0.5 to 1 TB plus one engine's copy of 1 to 1.5 TB, so one
  participant at a time on the 3.9 TB NVMe, with the datadir wiped between participants as the
  SearchBench `install` script already does.
- Prerequisites: docker group membership, access to the data disk, node 22 for the frontend. No sudo.

Cost at `1m`: about 27 groups x 7 points x 2 views, roughly 380 points and 54 restarts per
participant, three to four hours.

## 10. Verification

- Unit: attribute derivation is deterministic and uniform; ground truth equals a naive numpy top-1000
  on a 10K subset for every case; tie-aware and strict recall and tail at k=10/100/1000 on synthetic
  cases; degenerate detection; statistics helper (n, min, avg, p50, p95, p99, max) on known inputs;
  phases and info tag parsing including the "other" remainder; frontier, crossing, density rule,
  not-reached and only-above on hand-made point sets (shared test vectors for the Python driver and
  the frontend).
- Integration on the 100k slice, per participant: all returned ids satisfy the predicate, exactly k ids
  at every k, `exact` reaches recall 1.000, a startup sample is recorded for every group, a ladder with
  a deliberately wide gap produces `bracket too wide`, a missing group produces `unsupported`.
- Frontend: `npm run typecheck`, assembler test, offline Playwright test (zero network requests),
  crossing and score tests against the shared vectors.
- Host prerequisites on this machine: user in the `docker` group, a data disk with >= 200 GB (root has
  19 GB free), node 22 for the frontend.

## 11. Decisions log

Resolved in discussion on 2026-09-14:

1. Threads means concurrent clients; two views, 1 and 32. Engine threads are not an axis.
2. Five dataset families, dimension and metric tied to the family, small sizes prefixes of large ones,
   at most two multi-hour families at the top tiers, `100k` for development only.
3. Metric is not an axis; native metric per family; no cosine rows. (Every text family in v1 turned out
   unit-normalized, including Cohere v3, so ip and cosine coincide there; l2 comes from the image sets.)
4. k = 10, 100, 1000.
5. A query is (filter case, k, recall); recall values are chosen per family in the query list; no
   default recall and no recall selector; `exact` rows anchor the scale.
6. Participants are engine plus index family with one index per dataset size; per group they declare a
   ladder of knob settings, every setting measured; the cell is the crossing of the participant's own
   frontier with the row's recall, with the density rule; the graph behind every row is the audit.
7. Queries are defined per family, not per size; per-engine query files, no translator; unsupported is
   a missing group.
8. Core filter tier in v1; extended tier (or, in, not, nested, tags, prefix, regex) later.
9. Single load timer with optional phases and info tags; the engine owns the data.
10. Three sections: GENERAL (load time, on disk, max memory during load, startup), NO FILTER and
    FILTERED (max memory during queries, score, coverage, rows); every distribution reported as n, min,
    avg, p50, p95, p99, max; table, graph and detail are renderings of one complete record.
11. No cold-cache measurement; restart before every group gives the startup distribution; no sudo.
12. Two scores, ClickBench geomean over visible rows, coverage first.
13. Develop first on `100k` and `1m` (track A); large sizes are track B.

Open:

- Fifth family: MS MARCO Web Search or caselaw, decided before track B.
- Whether the 8-hour full-Cohere SereneDB figure included a table copy.
- Final query list and recall values per family (Appendix B is the starting point).

## Appendix A. Dataset landscape

### What the colleague already wired up (`searchbench-dev`, branch `codeworse/vector-search`)

| registry name | source | dims | dtype | metric | rows | ground truth | notes |
|---|---|---|---|---|---|---|---|
| `cohere-wiki-v3-*` (`smoke`, `4g`, `32g`, `128g`, `256g`, `512g`, `10M`, `en-de`, full) | HF `Cohere/wikipedia-2023-11-embed-multilingual-v3` | 1024 | float32 | ip | up to 247,150,776 (all 300+ languages, about 1 TB float32); `en-de` 62M | computed by his chunked BLAS, holdout of the tail of each language shard | the "250M" set; a 500 GB staged copy sits in `/home/ostapev/workspace/searchbench-vector-data/cohere_wiki_full` (not readable by my user). His VECTOR.md claims norms 12.3-16.3; `prepare` measured norm 1.0 on all 100k rows of the current HF files, so the vectors are unit-normalized |
| `dbpedia-openai3-1536-1M`, `-3072-1M` | HF `Qdrant/dbpedia-entities-openai3-text-embedding-3-large-*-1M` | 1536 / 3072 | float32 | angular | 990,000 base + 10,000 queries | computed | OpenAI text-embedding-3-large; unit-normalized |
| `openai-arxiv-100K/250K/1M/2M` | big-ann `OPENAI` family (`.fbin`) | 1536 | float32 | euclidean | up to 2,321,096 | official at 100K and 2M | OpenAI embeddings of arXiv abstracts |
| `caselaw-100K/1M/7M` | big-ann `CASELAW` family | 1536 | float32 | euclidean | up to 7,414,023 | official at all three | OpenAI embeddings of US case law |
| `dino-100M` | big-ann `DINO` family (`.u8bin`, `.bvecs` queries) | 1024 | uint8 | euclidean | 100M (102 GB) | official at 100M | DINOv2 image embeddings; opt-in in his registry |

He did not use the 768-d Cohere set (`wikipedia-22-12`, multilingual-22-12 model); VECTOR.md mentions
a 768-d truncation ladder that was never implemented. SereneDB indexed the full 247M corpus in under 8
hours in his setup (user's figure; his adapter built the index over a view on the parquet files, so
whether a table copy was included is to be confirmed). Besides the registry his branch has about 8.6k
lines of harness (download to parquet shards, `.fbin` decoding while downloading, ground-truth
computation, docker per engine, npz results, export to a static UI), seven adapters (serenedb,
pgvector, qdrant, lancedb, elasticsearch, opensearch, milvus), and measured results for his `mx-*`
scaling matrix (2 CPU / 4 GiB, 16 CPU / 32 GiB, 64 CPU / 128 GiB).

### What exists in the open, by dimension

Availability and licences are as I know them and must be re-checked when a dataset is adopted.

| dataset | dims | dtype | metric | rows | queries / GT | attributes | licence, availability |
|---|---|---|---|---|---|---|---|
| Deep1B (Yandex) | 96 | float32 | l2 (normalized, so also angular) | 1B, big-ann slices 10M/100M | 10K queries, official GT | none | public, free |
| MS SPACEV1B (Microsoft) | 100 | int8 | l2 | 1B | 29K queries, official GT | none | O-UDA, public |
| MS Turing-ANNS (Microsoft) | 100 | float32 | l2 | 1B | 100K queries, official GT | none | O-UDA, public |
| BIGANN / SIFT (INRIA) | 128 | uint8 | l2 | 1B, slices 10M/100M; SIFT1M classic | 10K queries, official GT | none | public, the most universal ANN set |
| YFCC-10M (big-ann 2023 filter track) | 192 | uint8 | l2 | 10M | 100K queries each with 1-2 tags, official filtered GT | bag of tags per row (200K vocabulary) | YFCC100M CC licences; public |
| Text-to-Image-1B (Yandex) | 200 | float32 | ip | 1B, slices 1M/10M/100M | 100K text-embedding queries (out of distribution), official GT | none | public, free |
| SSNPP (Meta) | 256 | uint8 | l2 (range search) | 1B | 100K, official | none | public, research |
| Qdrant filtering sets (arxiv-titles, h-and-m, random) | 384 / 2048 / 100 | float32 | cosine | 2.1M / 105K / 1M | with payload filters and filtered GT | keyword, integer, geo payloads | public, Qdrant repo |
| LAION CLIP embeddings | 512 or 768 | float16 | cosine (normalized) | 400M / 2B (100M subsets used by VectorDBBench) | none official | captions, sizes | Re-LAION only since 2024; availability unstable |
| MS MARCO Web Search (Microsoft) | 768 | float32 | ip | 100M documents, 10M subset | real query embeddings, official GT | none | O-UDA, public |
| Cohere `wikipedia-22-12` | 768 | float32 | ip / cosine | en 35M paragraphs plus ten other languages | none, compute | `views`, `langs`, `wiki_id`, `paragraph_id`, `title`, `url`, `text` | Apache-2.0 card over CC-BY-SA text; public |
| GIST1M (INRIA) | 960 | float32 | l2 | 1M | 1K queries, GT | none | public; old and small |
| DINO (big-ann `dino`) | 1024 | uint8 | l2 | 100M | official queries, GT at 100M | none | big-ann distribution |
| Cohere `wikipedia-2023-11-embed-multilingual-v3` | 1024 | float32 | ip (unit-normalized, measured) | 247M over 300+ languages; en 41.5M, de 20.8M, fr 17.8M, ru 13.7M, es 12.9M, ja 6.6M, zh 2.8M | none, compute | `title`, `url`, `text`, language by directory | Apache-2.0 card over CC-BY-SA text; public |
| Cohere `msmarco-v2.1-embed-english-v3` | 1024 | float32 | ip | about 113M passages (TREC RAG 2024 corpus) | TREC topics as real queries (few hundred) | none | public; verify card |
| Cohere `beir-embed-english-v3` | 1024 | float32 | ip | BEIR corpora, up to 8.8M | BEIR queries and qrels (relevance, not kNN) | none | public |
| big-ann `openai-arxiv` | 1536 | float32 | l2 (probably normalized OpenAI) | 2.3M | official queries, GT at 100K/2M | none | big-ann distribution |
| big-ann `caselaw` | 1536 | float32 | l2 (probably normalized OpenAI) | 7.4M | official queries, GT at 100K/1M/7M | none | big-ann distribution |
| `KShivendu/dbpedia-entities-openai-1M` | 1536 | float32 | cosine (ada-002) | 1M | none, compute | `title`, `text` | public; used by VectorDBBench and Qdrant |
| `Qdrant/dbpedia-entities-openai3-text-embedding-3-large-{1536,3072}-1M` | 1536 / 3072 | float32 | cosine (normalized) | 1M | none, compute | `title`, `text` | public |
| VectorDBBench bundles (Cohere 768 at 1M/10M, OpenAI 1536 at 500K/5M, LAION 768 at 100M, SIFT, GIST) | various | float32 | cosine / l2 | see left | GT computed by Zilliz, with label-filter variants | id-based and label filters | Zilliz object storage; terms unclear |

Less used but real: other Wikipedia embedding dumps on Hugging Face (mixedbread, Upstash bge-m3) at
1024 dims and tens of millions of rows; DataComp CLIP features for its 12.8B image pool (open, exotic);
the classic MIPS sets Music100 and Netflix (tiny). Gaps: no public corpus above 1M rows at 3072 dims;
no large non-normalized text embedding set at all (Cohere v3 turned out normalized too); real filter attributes at scale only in YFCC tags
and the Wikipedia language and views columns, so synthetic attributes remain necessary for the
selectivity ladder; every 1B-scale set is low-dimensional image or descriptor data.

## Appendix B. Initial query list (to be revised per family)

Shared by every family unless noted; the default recall set is 0.90 / 0.95 / 0.99, a family may
declare another set. Ids are stable once published; new queries get new ids. Rows sharing (filter
case, k) form one group and share one ladder of points per participant.

No filter, 10 rows in 3 groups plus exact:

| id | k | recall |
|---|---|---|
| V01 | 10 | 0.90 |
| V02 | 10 | 0.95 |
| V03 | 10 | 0.99 |
| V04 | 10 | exact |
| V05 | 100 | 0.90 |
| V06 | 100 | 0.95 |
| V07 | 100 | 0.99 |
| V08 | 1000 | 0.90 |
| V09 | 1000 | 0.95 |
| V10 | 1000 | 0.99 |

Filtered, 27 rows in 24 groups plus exact:

| ids | queries |
|---|---|
| V11-V34 | 8 core cases (eq-10, eq-1, eq-0.1, range-10, range-1, and-1, corr, xcorr) x k 10, 100, 1000 at recall 0.95 |
| V35, V36 | eq-1 and xcorr at k=10, recall 0.99 (the two hard ones; same groups as V12 and V32, no extra points) |
| V37 | eq-1 at k=10, exact (filtered id-mapping anchor) |

Family-specific additions: `wiki-v3-1024` adds `lang` (language of the query) and `xlang` (a fixed
other language) at k=10, recall 0.95. Degenerate rows at a given size are n/a.
