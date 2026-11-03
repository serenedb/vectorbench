# Methodology

VectorBench measures vector search in databases the way ClickBench measures analytics: every
participant runs the same queries on the same data and machine, tunes in the open, and publishes
everything it measured. What vector search adds is a quality variable. Results are approximate, and
every engine trades recall for speed along a curve of its own. So every participant publishes its
curve for every group of queries, measured point by point, and the table reads one number per cell
off that curve at the recall the row asks for. Table and graph are two renderings of the same record.

The exact formats are in [contracts.md](contracts.md). This document gives the rules.

## Vocabulary

| term | meaning |
|---|---|
| **dataset family** | a corpus with a fixed dimension, metric and attribute columns, e.g. `wiki-v3-1024` |
| **size** | a prefix of the family: `10m` is the first 10 million rows; every size uses the same queries |
| **query** (row) | (filter case, k, recall) with a stable id such as `V14`; `exact` as the recall means brute force |
| **group** | the rows that share (filter case, k); they share one set of points per participant |
| **participant** | a database plus an index family, e.g. `serenedb-hnsw-quant`; one index per dataset size |
| **view** | the load: Throughput (32 clients, QPS) or Latency (1 client) |
| **point** | one knob setting of a participant on a group, measured in one view |
| **curve** | the participant's Pareto frontier through its own points |
| **cell** | where the curve crosses the row's recall |

## Data

- **Families.** `wiki-v3-1024`: Cohere `wikipedia-2023-11-embed-multilingual-v3`, 1024 dimensions,
  inner product on unit-normalized vectors, all 323 languages interleaved so every prefix is
  multilingual. `sift-128`: the big-ann BIGANN descriptors, l2, with the official queries. Each family
  is searched under its native metric only.
- **Queries.** 10,000 per family, the same for every size. For Wikipedia they are held out from the
  last shard of seven languages, beyond the largest prefix, so a query is never its own neighbour.
- **Attributes.** Every row carries the same attribute columns, a pure function of the row id
  (splitmix64), so every engine and every size sees identical values: `cat10`, `cat100`, `cat1000`
  (uniform categories), `num` (uniform 0..999,999), `cluster` (the nearest of 100 k-means centroids
  of the row's own vector) and, for Wikipedia, the real `lang`.
- **Filter cases.** `none`; `eq-10`, `eq-1`, `eq-0.1` (equality on `cat10`, `cat100`, `cat1000`: 10%,
  1%, 0.1% of rows, uncorrelated with the vector); `range-10`, `range-1` (a range on `num`);
  `and-1` (`cat10` and a 10% range on `num`, 1% together); `corr` (the query's own cluster, about 1%,
  positively correlated); `xcorr` (the cluster farthest from the query, about 1%, negatively
  correlated); `lang` and `xlang` (the query's language and another one). The argument of every
  case is derived from the query id, so different queries hit different values.
- **k** is 10, 100 or 1000: the classic ANN regime, re-ranking for retrieval-augmented generation,
  and candidate generation.

## Ground truth and recall

- Exact top-1000 ids and distances per query, per size and per filter case, computed with float32
  BLAS over the whole prefix with the predicate as a mask.
- **Recall** of a point is the mean over its queries of tie-aware recall@k: a returned id counts if
  its true distance is at most the k-th ground-truth distance plus 1e-6. The strict id-set recall is
  stored too, and so is the **tail**, the share of queries with recall below 0.5, which exposes
  filtered searches that return nothing while the mean still looks acceptable.
- Engines must return exactly k ids that satisfy the predicate. `vectorbench check` verifies both on
  a development slice; a short answer is scored as is.
- A row is **n/a** at a size when fewer than 10 x k rows match its predicate for the median query.

## Participants tune in the open

1. One index configuration per participant per dataset size, public in the participant's
   `settings.yml`. Index type, quantization, `m` and `ef_construction` are the participant's choice;
   a head-to-head states whether they match (`vectorbench compare` prints a banner when they do not).
2. For every group the participant declares a **ladder** of knob settings. Knobs are variables in the
   query text, e.g. `SET sdb_hnsw_ef_search = {ef}` or `"hnsw_ef": "{hnsw_ef}"`, and every setting on
   the ladder is measured. The reader sees exactly what ran at every point.
3. The engine owns the data: `load` copies the rows into the engine's storage. Load time and size on
   disk are published.

## Points

4. **A point is a measurement**: client round-trip time per query, after the connection is set up and
   the knobs are applied, including parsing the k returned ids. The client is the engine's official
   Python driver over its fastest protocol (psycopg binary for SereneDB, gRPC for Qdrant).
5. **Clients are processes**, one connection each, started together. Throughput runs 32 clients and
   reports QPS, queries completed over wall time. Latency runs 1 client.
6. **Every distribution** is reported as n, min, avg, p50, p95, p99, max.
7. **Which queries a point runs.** Two modes, recorded in the result:
   - *Passes* (the default, for indexes that fit in RAM): a warmup, then passes over the query set in
     a fixed order with a per-client offset; the best pass is the headline and recall comes from the
     first. When everything is in RAM, repeating a query between points costs nothing.
   - *Slices* (`--point-queries`, for indexes larger than RAM): the query set is shuffled once with a
     fixed seed and each point of a group runs its own slice of it (1,000 queries at k=10, 500 at
     k=100, 200 at k=1000, fewer when a group has so many points that the set would not go round), so
     no query is timed twice within a group and no point reads what an earlier point cached. Every
     query of the slice runs; there is no warmup and no deadline. The group's first query runs
     untimed and is recorded as `first_query_s`, because an engine may load a field's index on it.
8. **Cold cache** (`--evict`, used with slices): before every group the engine's page cache is
   emptied: `drop_caches`, plus the vector files the engine memory-maps paged out of its own mappings
   (`process_madvise(MADV_PAGEOUT)` over the paths in the participant's `evict_mapped`), since pages a
   process maps survive `drop_caches`. Graphs and quantized codes the engine holds in RAM stay.

## Curves and cells

9. **Curve** = the participant's Pareto frontier through its own points for a group and view. A point
   that another point beats on both recall and speed is drawn hollow and ignored.
10. **Cell** = the crossing of the curve with the row's recall, interpolated log-linearly between the
    two neighbouring frontier points. The graph draws the vertical line at the row's recall and marks
    every crossing, so the cell and the graph show the same thing.
11. **Density rule.** The two points that bracket the row's recall must be within 0.02 recall of each
    other, or be adjacent values of an integer knob; otherwise the cell fails as `bracket too wide`.
    On the usual curve the chord lies under the curve, so a sparse ladder only hurts its owner.
12. **Not reached**: the curve's best recall is below the row's; the cell reads `reached 0.97` and
    fails. **Only above**: every point is above the row's recall; the cell takes the lowest-recall
    point.
13. **Exact rows** read the brute-force point directly.
14. **Graph-only points** (`graph_only` in the result) are drawn and never read: a cell, a group's bar
    and the density rule skip them. They show, for example, how fast a graph walk on the codes alone
    is, below every row's recall.

## Load, disk, memory, startup

15. **Load time** is the wall time of the participant's `load` script, from an empty engine until the
    index is complete, merged and persisted: ingest, index build, compaction and any settling are all
    inside it. `load` may report phases (`ingest`, `index`, `compaction`, ...), shown as a stacked bar.
16. **On disk** is the participant's `data-size` right after `load`.
17. **Memory peaks** come from the engine container's cgroup (`memory.peak`): one for the load, one
    for the unfiltered groups and one for the filtered groups.
18. **Startup** is the time from `start` to the first successful `check`, polled every 100 ms. `check`
    must answer a real vector query, so an engine that loads its graphs lazily pays for it here. The
    first groups of a run begin with a graceful restart to sample startup; after that the engine stays
    up.

## Scores

19. Two scores, NO FILTER and FILTERED: per row, the ratio of a participant's cell to the best cell in
    the row; the score is the geometric mean of those ratios over the visible rows where the
    participant answered (1.00 is best). Coverage, the share of visible rows answered, comes first.
    Memory and startup are shown, never scored.
20. **Hardware** (CPUs, memory, storage, host) is recorded in every result and shown on the page. The
    engine may be capped with `--cpuset` and `--memory`; the cap, if any, is recorded too.
