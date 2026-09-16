# How the benchmark should measure

Status: proposal. Replaces the ladder-enumeration approach in `docs/contracts.md` sections 6 and 9.
Depends on the knob survey in `docs/knobs.md`.

## Three things are wrong today

**1. The comparison is between strategies, not implementations.** Every engine sweeps its own
ladder, and those ladders do different things. We widen the beam. Qdrant keeps the beam narrow and
raises the rescore pool. So a Qdrant point at recall 0.99 and a SereneDB point at recall 0.99 were
reached by different means, and which is faster says as much about which knob each participant's
settings file happened to sweep as about the engine. We already build the same index; we have to
search it the same way too.

**2. Almost all the timing is spent where the answer is known.** On sift at a million rows, 71% of
our timed points and 79% of Qdrant's landed above 0.99 recall. Once a beam of 16 reaches 0.99, a
beam of 300 tells us only that it is slower.

**3. The bars are three fixed numbers.** 0.90, 0.95, 0.99 fit no particular dataset. Where the index
is large relative to a small dataset every engine is already above them; where it is small relative
to a large one nobody reaches them.

## The shared parameter space

Two knobs, same meaning for everyone, from `docs/knobs.md`:

| | Elasticsearch | Qdrant | SereneDB |
|---|---|---|---|
| beam | `num_candidates` | `hnsw_ef` | `sdb_hnsw_ef_search` |
| rescore pool, as a multiple of k | `rescore_vector.oversample` | `quantization.oversampling` | `sdb_hnsw_rerank_factor` |

The pool knob did not exist on our side until today; the pool was the whole beam, so we could not
express what the others run. That is now `sdb_hnsw_rerank_factor`, capped by the beam, with 0
meaning the old behaviour.

Everything outside these two is either matched at build time (`m`, `ef_construction`,
quantization), structurally different and to be stated rather than matched (segment count), or an
engine's own filtered-search strategy (`acorn`, `visit_percentage`, `sdb_hnsw_filter_mode`), where
each engine uses its best and the result records which.

## Phase 1: calibrate, once per (dataset, size)

Per participant, per group.

1. **Probe recall, not speed.** Recall needs one pass over the query set and does not care how many
   clients make it, so probes run at full concurrency and cost a fraction of a second where a timed
   point costs five. No timing is kept.
2. **For each rescore pool in a small set (1, 2, 4, 8), binary-search the beam** over the values the
   participant declared, by index, so engine constraints hold. About `log2(rungs)` probes per bar,
   memoised across bars.
3. Output per (group, bar): every (beam, pool) that reaches it, per plan.

Roughly 20 recall probes per group, about six seconds.

## Phase 2: choose the bars, once per (dataset, size)

From the curves phase 1 produced, across all participants:

- Take the recall interval every participant can reach: highest of their minimums to lowest of their
  maximums.
- Place **three bars** spread across it, snapped to readable values (0.9, 0.95, 0.99, 0.995, 0.999,
  0.9999). A small dataset with a large index lands high, near 0.99 and 0.999; a large dataset with
  a small index lands low.
- An empty or single-point interval is reported as a speed comparison at saturation, labelled as
  such rather than dressed up as a recall comparison.

## Phase 3: measure, every run

For each bar, several (beam, pool) pairs reach it and we want the fastest. Timing is not equally
expensive in the two views, so:

- **Time every candidate in the throughput view.** At 32 clients a point costs under a second.
- **Time only the winner in the single-client view.** That view is the whole expense of a run.

Per group: about 12 cheap points and 3 expensive ones, against 20 to 51 expensive ones in each of
two views today.

| | now | proposed |
|---|---|---|
| recall probes | free, but only at timed points | ~20, full concurrency, ~0.3 s |
| throughput points | 20 to 51 | ~12, under a second each |
| single-client points | 20 to 51 | 3 |
| single-client seconds | 60 to 250 | 9 to 15 |

## Phase 4: re-runs are cheap

Calibration is written to `datasets/<family>.calibration.json` and committed. A run after a code
change skips phases 1 and 2 and costs only phase 3. Calibration is invalidated by anything that
moves the recall curve: build settings, engine version, dataset. Those are recorded with it and
checked on load.

## Participants

Drop OpenSearch. Its matched eight-bit build runs on the plugin's Lucene engine, which is
Elasticsearch's engine, so we would be measuring Lucene twice and paying for it twice. faiss in
OpenSearch cannot produce eight-bit codes at all: it goes sixteen bits, then four. If a faiss number
is wanted it has to be a separate labelled build at a different quantization, and it is not a
matched comparison.

That leaves SereneDB HNSW, SereneDB IVF, Qdrant and Elasticsearch.

## What this replaces

- The per-row `recall` field and `recall_by_size` become `bars` in the calibration.
- `bracket_too_wide` and the frontier crossing rule stop mattering for headline numbers, because
  every timed point sits on a bar. The frontier is still computed from the probes for the curve.
- `vectorbench targets` becomes `vectorbench calibrate`.

## Open questions

1. **Filter mode in the headline.** SereneDB has auto, walk, bridge and two others. Auto is what a
   user gets. I would calibrate and publish auto only, and keep the forced modes as a labelled
   diagnostic run, rather than letting us pick the best mode per bar when the competitors' equivalent
   is chosen for them internally.
2. **Which pool values.** 1, 2, 4, 8 covers what Qdrant and Elasticsearch default to. Adding "whole
   beam" as a fifth is what we did before today and is worth keeping as a reference point.
3. **Quantizer range.** Both competitors clip the quantization range by a quantile; we use global
   min and max. That is a build-time difference at the same bit width and it is not currently
   matched. Fixing it is an engine change, not a benchmark one.
