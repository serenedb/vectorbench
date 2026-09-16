# VectorBench contracts

The exact formats every part of the benchmark agrees on: the driver (`lib/vectorbench`), the
participant directories, the prepared data and the frontend. `DESIGN.md` explains why; this file says
what. When they disagree, this file wins and DESIGN.md gets fixed.

## 1. Dataset family definition: `datasets/<family>.yml`

```yaml
family: wiki-v3-1024            # id prefix; dataset id is <family>-<size>
title: Cohere Wikipedia 2023-11, multilingual v3
dims: 1024
metric: ip                      # ip | l2 ; the only metric this family is ever run under
source:                         # see lib/vectorbench/sources
  kind: hf                      # hf | bigann
  ...
sizes: {100k: 100000, 1m: 1000000, 10m: 10000000, 100m: 100000000}
queries_count: 10000
gt_depth: 1000
shard_rows: 100000              # rows per prepared parquet shard
cluster_k: 100                  # k-means clusters for the `cluster` attribute, trained on the first 1m rows
filter_cases:                   # name -> predicate spec (section 3)
  none: {}
  eq-10: {op: eq, field: cat10}
  ...
queries:                        # rows; ids stable once published
  - {id: V01, filter: none, k: 10, recall: 0.90}
  - {id: V04, filter: none, k: 10, recall: exact}
  ...
```

`recall` is a float in (0, 1) or the string `exact`. A **group** is `(filter, k)`; its key is
`"<filter>/<k>"`, and exact rows form their own groups keyed `"exact/<filter>/<k>"`.

## 2. Prepared data: `$VECTORBENCH_DATA_DIR/<family>-<size>/`

```
base/part_00000.parquet ...     # shard_rows rows each, the last one shorter
queries.parquet                 # nq rows
query_args.parquet              # long format: one row per (case, qid)
gt/<case>.npz                   # per filter case (incl. none)
centroids.npy                   # float32 [cluster_k, dims]
manifest.json
```

`base` schema, in this column order:

| column | arrow type | definition |
|---|---|---|
| `id` | int64 | 0-based row position in the family stream; identical across sizes |
| `emb` | fixed_size_list<float32>[dims] | the vector, float32 whatever the source dtype |
| `cat10` | int16 | `h(id, 1) % 10` |
| `cat100` | int16 | `h(id, 2) % 100` |
| `cat1000` | int16 | `h(id, 3) % 1000` |
| `num` | int32 | `h(id, 4) % 1_000_000` |
| `ts` | timestamp[s] | `2020-01-01T00:00:00Z + id seconds` |
| `cluster` | int16 | index of the nearest centroid (squared l2) in `centroids.npy` |
| `lang` | string | language code from the source, or `""` when the source has none |
| `title` | string | title from the source, or `""` |

`h(id, seed)` is splitmix64 applied to `splitmix64(id) XOR (seed * 0x9E3779B97F4A7C15)`, all uint64
with wrap-around, as implemented in `lib/vectorbench/attributes.py`. The small size is the exact prefix
of the large size: shard `i` of `<family>-1m` is byte-identical to shard `i` of `<family>-10m`.

`queries.parquet`: `qid int32` (0..nq-1), `emb`, `cluster` (nearest centroid of the query vector),
`lang`. Queries come from a pool disjoint from every size's base rows (section 7 of the family's
source spec).

`query_args.parquet`: `case string, qid int32, v int64, lo int64, hi int64, v2 int64, s string`.
Which columns a case uses is given by its predicate spec; unused ones are null.

`gt/<case>.npz`: `ids int32 [nq, gt_depth]`, `dists float32 [nq, gt_depth]` (ascending; squared l2
for `l2`, negative inner product for `ip`, so smaller is always better; padded with -1 / +inf when fewer
rows match), `matches int64 [nq]` (rows satisfying the predicate for this query at this size).

`manifest.json`: `{family, size, rows, nq, dims, metric, gt_depth, shard_rows, shards: [{path, rows,
sha256}], norms: {min, p50, mean, max}, attributes: [...], filter_cases: {...}, queries: [...],
created, tool_version}`.

## 3. Filter predicate specs and per-query arguments

| op | spec | argument derivation for query `qid` | predicate |
|---|---|---|---|
| (none) | `{}` | | true |
| `eq` | `{op: eq, field: F}` | `v = h(qid, caseseed) % cardinality(F)` | `F = v` |
| `eq` on `cluster` | `{op: eq, field: cluster, value: query_cluster}` | `v = cluster of the query vector` | `cluster = v` |
| `eq` on `cluster` | `{op: eq, field: cluster, value: far_cluster}` | `v = index of the centroid farthest (l2) from the query vector` | `cluster = v` |
| `eq` on `lang` | `{op: eq, field: lang, value: query_lang}` | `s = lang of the query` | `lang = s` |
| `eq` on `lang` | `{op: eq, field: lang, value: other_lang}` | `s = langs[(index(lang of query) + 1) % len(langs)]` | `lang = s` |
| `range` | `{op: range, field: num, fraction: f}` | `w = round(f * 1e6)`, `lo = h(qid, caseseed) % (1e6 - w + 1)`, `hi = lo + w - 1` | `lo <= num <= hi` |
| `and` | `{op: and, terms: [eq-spec, range-spec]}` | first term with `caseseed`, second with `caseseed + 1`; stored as `v` and `lo`/`hi` | conjunction |

`caseseed = h(crc32(case name), 0)`; cardinality of `cat10/cat100/cat1000` is 10/100/1000. Statements
receive the arguments as named parameters `$v`, `$lo`, `$hi`, `$v2`, `$s`, plus `$q` (the query vector)
and `$k`.

Degenerate: a row `(case, k)` is n/a at a size when `median(matches) < 10 * k`.

## 4. Participant directory

```
<participant>/                  # directory name = participant id, e.g. serenedb-ivf
  benchmark.sh                  # exports ENGINE_NAME, ENGINE_TAGS (JSON array string), then exec ../lib/benchmark.sh "$@"
  install                       # one-time: pull image (only if the tag is not local), wipe container and datadir
  start                         # start the engine detached; must return promptly; must NOT wait for readiness
  stop                          # graceful stop; returns when the process is gone
  check                         # exit 0 iff the engine answers a real query; used at 100 ms for startup timing
  load                          # whole recipe: ingest + index + settle; prints the two tags; blocks until settled
  data-size                     # prints bytes on disk (data + index)
  version                       # prints the engine version string
  queries.sql | queries.json    # groups (section 5)
  settings.yml                  # connection, image, per-size index params and ladders (section 6)
  client.py                     # class Client (section 7)
  README.md
  results/<participant>_<family>-<size>.json
```

Environment the driver exports to every script (and `lib/benchmark.sh` exports the same when run by
hand):

| variable | meaning |
|---|---|
| `VECTORBENCH_DATA_DIR` | host root of prepared data |
| `VECTORBENCH_DATASET` | `<family>-<size>` |
| `VECTORBENCH_DATASET_DIR` | `$VECTORBENCH_DATA_DIR/$VECTORBENCH_DATASET` |
| `VECTORBENCH_ENGINE_DIR` | where the engine keeps its own data: `$VECTORBENCH_DATA_DIR/engines/<participant>/<dataset>` |
| `VECTORBENCH_CPUSET`, `VECTORBENCH_MEMORY` | docker `--cpuset-cpus` and `--memory` values for the engine container |
| `VECTORBENCH_METRIC`, `VECTORBENCH_DIMS` | from the family |
| `VB_*` | every key of `settings.yml: env` uppercased with prefix `VB_`, e.g. `VB_PORT`, `VB_CONTAINER`, `VB_IMAGE` |
| `VB_INDEX_<KEY>` | every key of the size's `index` block, uppercased, e.g. `VB_INDEX_QUANT=sq8` |

`load` tags (stdout, last occurrence wins, both optional):

```
VECTORBENCH_PHASES={"ingest": 312.4, "index": 501.0, "compaction": 88.2}
VECTORBENCH_INFO={"segments": 12, "index_bytes": 22000000000}
```

## 5. Query files

`queries.sql`: blocks introduced by a header comment naming the group key; `*` matches any k.
Statements are separated by `;`. All but the last are **setup**, run once per point on each
connection; the last is the **query**, run per query vector. Knob variables `{name}` are substituted
by the driver from the ladder before the block reaches `client.py`. Named parameters `$q $k $v $lo $hi
$v2 $s` are bound by `client.py` per query.

```sql
-- group: none/*
SET sdb_ivf_search_nprobe = {nprobe};
SELECT id FROM items ORDER BY emb <#> $q LIMIT $k;

-- group: exact/none/*
SET sdb_disable_top_k_optimization = true;
SELECT id FROM items ORDER BY emb <#> $q LIMIT $k;
```

`queries.json`: one object whose keys are group keys and whose values are the block in the engine's
own JSON dialect; the driver serializes the value, substitutes `{knob}` textually, and hands the text
to `client.py`. A group missing from the file is `unsupported`. Key resolution order: exact
`"<filter>/<k>"`, then `"<filter>/*"`.

## 6. `settings.yml`

```yaml
env: {port: 5499, container: vectorbench-serenedb-ivf, image: serenedb/serenedb:26.09.1}
connection: {host: 127.0.0.1, port: 5499, user: postgres, dbname: postgres}   # passed to Client(cfg)
defaults:
  index: {quant: sq8}
  ladder: {nprobe: [1, 2, 4, 8, 16, 32, 64, 128]}
datasets:
  wiki-v3-1024:
    100k: {ladder: {nprobe: [1, 2, 3, 4, 6, 8, 12, 16, 24, 32]}}
    1m:   {index: {posting_size: 1024}, ladder: {nprobe: [2, 4, 8, 12, 16, 24, 32, 48, 64]},
           groups: {"eq-0.1/*": {ladder: {nprobe: [8, 16, 32, 64, 128, 256]}}}}
```

Resolution for a (dataset size, group): `defaults` < `datasets.<family>.<size>` < its `groups["*/<k>"]`
< `groups["<filter>/*"]` < `groups["<filter>/<k>"]`, later keys winning. `"*/<k>"` is for knobs tied to
k, such as a beam that is also the result ceiling. A ladder with several knobs is the cartesian product
in the order written, over the knobs the group's block names (a knob the block does not mention is
not a knob of that group); keep ladders to about seven points per knob. Exact groups ignore ladders.

`plan_rules` (optional): lists of substrings the plan returned by `Client.explain` must contain,
under `always`, `approximate` (non-exact groups), `exact`, `filtered` (filter != none); an entry that is
itself a list names alternatives, any one of which satisfies it; the `<kind>_not`
variants list substrings that must be absent. The driver runs
`explain` once per group on the first ladder point, stores the plan in the group record (`plan`), and
fails the group with `plan check failed: ...` when a rule is not met, so a query that silently fell back
to a scan can never be published as a measurement.

## 7. `client.py`

```python
class Client:
    def __init__(self, cfg: dict): ...             # settings.yml: connection, plus metric, dims, dataset, index (resolved block) added by the driver
    def connect(self) -> None: ...                 # one connection per worker process
    def prepare_group(self, block: str) -> object: # parse the dialect, run setup statements; return a handle
    def search(self, handle, vec, k: int, args: dict) -> list[int]:
        """args has the keys v, lo, hi, v2, s that this group's case defines (others absent).
        Returns ids in rank order, at most k. Must not sort, dedupe or pad."""
    def explain(self, handle, vec, k: int, args: dict) -> str: ...   # optional: the engine's plan text for the query
    def close(self) -> None: ...
```

One `Client` instance per worker process. `vec` is a `numpy.ndarray` of float32. Returned ids are the
`id` column values. The driver validates on the 100k slice that every returned id satisfies the
predicate and that exactly k ids come back.

## 8. Result file: `<participant>/results/<participant>_<family>-<size>.json`

```json
{
  "participant": "serenedb-ivf", "name": "SereneDB IVF", "system": "SereneDB", "family": "ivf",
  "version": "26.09.1", "label": null, "os": "Ubuntu 24.04.4 LTS", "date": "2026-10-01",
  "dataset": "wiki-v3-1024-100k", "tags": ["C++", "SereneDB", "Postgres-wire"],
  "hardware": {"cpus": 32, "cpuset": "0-31", "memory_bytes": 68719476736, "host": "...", "storage": "nvme"},
  "load_time": 812.4, "load_phases": {"ingest": 312.4, "index": 501.0}, "disk_bytes": 22000000000,
  "disk_info": {"segments": 12}, "memory_peak": {"load": 41000000000, "unfiltered": 9000000000, "filtered": 11000000000},
  "startup": {"n": 54, "min": 0.9, "avg": 1.2, "p50": 1.1, "p95": 1.9, "p99": 2.3, "max": 2.4},
  "index": {"params": {"quant": "sq8"}, "ddl": "..."},
  "groups": [
    {"key": "eq-1/10", "filter": "eq-1", "k": 10, "view": "throughput", "clients": 32,
     "status": "ok", "block": "SET ...; SELECT ...", "startup": 1.15, "memory_peak": 8700000000,
     "points": [
       {"ladder_index": 0, "knobs": {"nprobe": 8}, "recall": 0.902, "recall_strict": 0.897, "tail": 0.003,
        "qps": 24100.0, "latency_ms": {"n": 96400, "min": 0.6, "avg": 1.33, "p50": 1.2, "p95": 2.1, "p99": 3.4, "max": 15.0},
        "queries": 96400, "duration": 4.0,
        "passes": [{"qps": 24100.0, "avg": 1.33, "p50": 1.2, "p99": 3.4, "queries": 48200, "duration": 2.0}]}
     ]},
    {"key": "exact/none/10", "filter": "none", "k": 10, "exact": true, "view": "throughput", "clients": 32, "status": "ok", "points": [{"...": "..."}]},
    {"key": "xcorr/1000", "filter": "xcorr", "k": 1000, "view": "throughput", "status": "n/a", "reason": "degenerate: median 9800 matching rows < 10000"},
    {"key": "range-1/10", "filter": "range-1", "k": 10, "view": "latency", "status": "unsupported"}
  ]
}
```

Statuses: `ok`, `unsupported`, `n/a`, `error` (with `reason`). Per point, `recall` is tie-aware
recall@k, `recall_strict` the id-set version, `tail` the share of queries below 0.5, all from the first
pass; `qps`, `latency_ms` and `passes` from the best pass (max qps) with `latency_ms` its distribution.
`views`: `throughput` (clients = tier CPUs, 32) and `latency` (clients = 1).

## 9. Frontier and crossing (implemented identically in `lib/vectorbench/frontier.py` and the frontend; test vectors in `lib/vectorbench/testdata/frontier_cases.json`)

Input: a group's points for one view, a metric name, a direction (`higher` for qps, `lower` for
latency statistics), and the row's recall `r`.

1. Keep points with a numeric recall and metric.
2. **Frontier**: sort by recall descending, then by metric best-first; sweep, keeping a point only if
   its metric is strictly better than every kept point (which all have higher or equal recall). The
   result, re-sorted by recall ascending, is the Pareto frontier.
3. If the frontier is empty: `{status: "none"}`.
4. If `r > max recall + 1e-9`: `{status: "not_reached", reached: max recall}`.
5. If `r <= min recall + 1e-9`: `{status: "above", value: metric of the min-recall point, point}`.
6. Otherwise `a` = frontier point with the largest recall `<= r`, `b` = smallest recall `>= r`.
   If `a is b` (recall equals `r`): `{status: "point", value}`.
7. Density is checked on **all** usable points (dominated ones included), since it measures what the
   participant declared: let `da`, `db` be the points bracketing `r` by recall among all points and
   `gap = db.recall - da.recall`; `adjacent_int` is true when both points declare the same knobs, all
   but one agree, and that one is an integer knob whose values differ by 1 (adjacent on the ladder). If `gap > 0.02 and not adjacent_int`: `{status: "bracket_too_wide",
   gap}`. The value is then read between the frontier points `a`, `b` bracketing `r`.
8. `value = exp(ln(va) + (r - ra) / (rb - ra) * (ln(vb) - ln(va)))`;
   `{status: "interpolated", value, a, b}`.

Exact rows: `{status: "point", value}` from the exact group's single point; `none` if absent.

Cell status on the page: `ok` (`point`, `interpolated`, `above`), `reached x.xx` (`not_reached`),
`bracket too wide`, `unsupported`, `n/a`, `error`.

## 10. Scores (frontend)

For a section and the visible rows: per row, `best` = the best ok value among participants (max for
`higher`, min for `lower`); a participant's ratio is `best / value` (higher) or `value / best`
(lower); its score is the geometric mean of its ratios over the rows where it is ok; its coverage is
`ok rows / visible rows`. Columns sort by coverage descending, then score ascending (1.00 is best).
Memory peak rows and startup are shown, never scored.

## 11. Assembled page data: `frontend/results.json`

Written by `vectorbench assemble` from every `*/results/*.json` (skipping `*.partial.json`) plus the
family definitions, so the page never reads a family yml itself:

```json
{
  "generated": "2026-10-01T12:00:00Z",
  "families": {
    "wiki-v3-1024": {
      "family": "wiki-v3-1024", "title": "...", "dims": 1024, "metric": "ip",
      "sizes": {"100k": 100000, "1m": 1000000},
      "filter_cases": {"none": {}, "eq-1": {"op": "eq", "field": "cat100"}},
      "queries": [{"id": "V01", "filter": "none", "k": 10, "recall": 0.9}, {"id": "V04", "filter": "none", "k": 10, "recall": "exact"}]
    }
  },
  "results": [ { "...one result file object per participant and dataset size, section 8, plus": "_source" } ]
}
```

Sections on the page: a query with `filter == "none"` belongs to NO FILTER, every other query to
FILTERED. The row for query `q` reads the participant's group `"<filter>/<k>"` (or `"exact/<filter>/<k>"`
when `recall == "exact"`) for the selected view.

## 13. Recall targets per dataset size

A row's `recall` is the bar its cell is read at, never what is measured, so it can be chosen after
the run. What is right at one size is wrong at another: a 1% filter over 1M rows leaves ~10K
matches, where every engine answers k=10 exactly and any bar below 1.0 compares speed only, while
the same row at 10M separates them. A family file may therefore carry per-size overrides:

```yaml
recall_by_size:
  10m:
    V03: 0.98
    V11: 0.97
```

Keys are sizes declared in `sizes`; values are row ids with a recall in (0, 1) or `exact`.
`Family.queries_for(size)` applies them, and the dataset manifest records the resolved rows.

`vectorbench targets --dataset <id>` proposes the block from the measured frontiers of every
participant that ran the dataset. Per (group, view) it reads each candidate bar through the
crossing rule of section 9 and classifies the row:

| verdict | meaning |
|---|---|
| `ok` | the declared bar is already the most informative candidate |
| `replace` | another bar is read by more participants, or crossed rather than merely cleared |
| `saturated` | every participant's cheapest declared point already clears the bar: a speed-only row |
| `degenerate` | every participant declines the group at this size, because the median match set is smaller than k |
| `no_target` | no candidate is readable: a ladder problem, not a target problem |

Rows on the same group are assigned together, so a group sampled by three rows keeps three distinct
bars instead of collapsing onto one. A `no_target` or `bracket_too_wide` verdict is a coverage
failure and counts against the participant exactly like a slow cell.

## 14. Reading a head-to-head

`vectorbench compare --dataset <id> --us <participant> --them <participant>` reads every row of the
dataset at the bar that dataset declares, on both views, and reports the ratio with the winner's
direction already applied, so above one always means `--us` is ahead. `--section unfiltered` or
`--section filtered` narrows it; `--verbose` lists every row rather than only losses and
unreadable cells.

A row falls into one of five buckets:

| bucket | meaning |
|---|---|
| win, tie, loss | both sides answered; the tie band is two percent, below the noise of a short pass |
| `unreadable` | one side could not answer at that bar, so there is no comparison; this is a coverage failure and counts against whichever side could not answer |
| `n/a` | both sides declined the group because the shape is out of scope at this size (section 13) |

`unreadable` is reported separately from `loss` on purpose. A participant whose ladder stops short
of the bar has not lost a race, it has failed to enter one, and the fix is its ladder or its build
rather than its speed.

## 15. Load budget

`vectorbench run --load-timeout <seconds>` puts a wall-clock budget on the load recipe. A recipe
that passes it is stopped, together with its whole process tree, and the run is published with a
`load_aborted` record naming the budget and the last of the recipe's output. That is a result about
the engine, not a missing cell: at the largest sizes an engine that cannot build the index in a
working day has answered the question.

The budget is enforced by a watchdog, not by waiting on the process with a timeout. The recipe's
output is drained first, so a recipe that hangs, or one that prints progress forever, never reaches
such a wait at all. `tests/test_load_budget.py` covers both shapes and checks that a grandchild of
the recipe does not outlive it.

## 16. Build matching

`vectorbench compare` reads the build each side recorded and prints a mismatch banner before any
numbers when they differ. Three things have to agree: `m`, `ef_construction`, and the bits per
dimension of the stored codes, which each engine spells differently (`sq8`, `int8_hnsw`, `4x`,
`scalar`, and so on) and which the comparison maps to a number.

This is not belt and braces. A Qdrant load record from before the participants were aligned carries
`quant: none`, so a comparison against it would have measured our eight-bit index against their full
precision one and read the size difference as ours. A mismatch is a fact about the run, not about
the settings files, so it is read from what the loaders recorded rather than from what the settings
declare.

A run in flight writes `<name>.partial.json` beside the published file and promotes it at the end,
so both exist at once. The partial is the fresher of the two and is used, with the participant
marked `RUN IN PROGRESS`, because an unfinished run must never read as a result.
