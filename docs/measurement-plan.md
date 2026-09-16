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

The pool knob did not exist on our side until this week; the pool was the whole beam, so we could
not express what the others run. `sdb_hnsw_rerank_factor` now means exactly what their knob means,
0 included -- `docs/hnsw-parity.md` has the reading of all three implementations that established
it. Both HNSW participants sweep it today, at the same two values.

Everything outside these two is either matched at build time (`m`, `ef_construction`,
quantization), structurally different and to be stated rather than matched (segment count), or an
engine's own filtered-search strategy (`acorn`, `visit_percentage`, `sdb_hnsw_filter_mode`), where
each engine uses its best and the result records which.

## Phase 1: where the bars go, from one engine

Bars are a property of the dataset and the index size, not of a participant, so one engine's sweep
settles them. Qdrant is the one: it is the closest competitor, its knobs are the shared ones, and
whatever recall band it can reach is a band the row can meaningfully ask about.

1. **Probe recall, not speed.** Recall needs one pass over the query set and does not care how many
   clients make it, so probes run at full concurrency and cost a fraction of a second where a timed
   point costs five. No timing is kept.
2. Sweep Qdrant's declared beam rungs against each pool in {1, 2, 4, 8}. That is the curve.
3. Place **3 to 5 bars** across the reachable band, snapped to readable values (0.8, 0.9, 0.95,
   0.99, 0.995, 0.999, 0.9999) and spread so no two sit within a hair of each other. A small dataset
   under a large index lands high, near 0.99 and 0.999, because everything reaches 0.9 there and a
   0.9 row would separate nobody; a large dataset under a small index lands low, because nobody
   reaches 0.99 and a 0.99 row would be empty for everyone.
4. A band too narrow for three bars is reported as a speed comparison at saturation, labelled as
   such rather than dressed up as a recall comparison.

## Phase 2: per engine, find the knobs that land on each bar

Still recall only, still free. For each participant and each bar, binary-search the beam by rung
index (so each engine's own constraints hold -- Qdrant will not search a segment with a beam under
what it asks of it, ours floors the beam at k) at each pool value, and keep the cheapest setting
that lands **on** the bar.

"On the bar" is the goal, not near it. A point that sits exactly on a bar needs no interpolation and
is the honest answer to "how fast is this engine at this recall". Where a rung ladder cannot hit a
bar exactly -- and it often cannot, since recall moves in steps -- keep the two rungs that bracket
it, the last below and the first above.

That is the cost rule: **at most two timed points per engine per bar**, and one wherever the ladder
hits the bar squarely. Not the twenty to fifty-one this sweeps today, and not one per candidate
setting either -- the search for the right setting is done in recall probes, which are free.

## Phase 3: time the chosen points

Both views, the same one or two points per bar. Nothing is timed that was not chosen.

| | now | proposed |
|---|---|---|
| recall probes | free, but only at timed points | ~20 per participant, full concurrency, ~0.3 s |
| timed points per group per view | 20 to 51 | 3 to 10 (1-2 per bar, 3-5 bars) |
| single-client seconds per group | 60 to 250 | 9 to 30 |

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
2. **Which pool values.** 1, 2, 4, 8 covers what Qdrant and Elasticsearch default to (Elasticsearch
   defaults to 3). 0 -- answer from the codes, no rescore -- is Qdrant's scalar default and is worth
   probing as a fifth, because it is the fastest point any engine has and on some shapes it clears a
   low bar on its own.
3. **Quantizer range.** Both competitors clip the quantization range by a quantile; we use global
   min and max. That is a build-time difference at the same bit width and it is not currently
   matched. Fixing it is an engine change, not a benchmark one.
