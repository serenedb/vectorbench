# HNSW: SereneDB against Qdrant, line by line

Read end to end on 2026-09-16 against qdrant `lib/segment/src/index/hnsw_index/` and
serenedb `iresearch/formats/hnsw/`. The question this answers is not "are both HNSW"
but "does a benchmark that builds both with the same m, ef_construction and
quantization compare two implementations or two algorithms". Anything in the second
column is a reason a measured difference is not an implementation difference.

## Confirmed identical

| Step | Qdrant | SereneDB |
| --- | --- | --- |
| Level sample | `round(-ln(U) / ln(max(m,2)))`, `U ~ Uniform(0,1)` | same, `+1` for a 1-based level count, clamped at `kHnswMaxLevel` |
| Level width | `m0 = 2m` default, `level_m(0) = m0` else `m` | `M0() = 2 * M()`, same split |
| Linking range | `min(point_level, entry_level) ..= 0` | `min(top, entry_top) .. 0` |
| Descent | greedy beam-1, all links each round, move on strictly better | same, plus a visited set (see note) |
| Level-0 beam | pop best, stop on `score < worst_of_beam`, admit into a fixed-ef queue, push to the frontier only what was admitted | same; our `size() >= ef &&` guard is implied by theirs, since nothing is evicted before the beam is full |
| Admission tie | `FixedLengthPriorityQueue::push` rejects when `worst >= value`, and `ScoredPointOffset`'s `Ord` is the score alone | `cand.score <= nearest.front().score` rejects; the same rule |
| Neighbour count fed to the scorer | `limit = level_m(level)`, a no-op for plain HNSW | no truncation, same result |
| Selection | "not closer than base", best-first, stop at `level_m` | same |
| Backlink pruning | append to a free slot, else re-run the heuristic over existing + new | same |
| Both-processed skip | pairs a previous heuristic already cleared are not re-tested | same |
| Entry point, unfiltered | one point, the highest level seen | one point, the highest level in the segment |
| ef floor | `ef = max(hnsw_ef, top)` | `ef = max(ef_search, min_ef)` |

The descent's visited set is safe rather than merely cheap: `cur` only improves, so a
node that did not beat `cur` when it was first scored cannot beat it later, and
Qdrant re-scores it only to reject it again.

## Differences, and what was done

**1. Ties in the selection heuristic — fixed.** Qdrant's `is_redundant` compares
strictly *except* when the candidate and the already-selected link are exactly
equidistant from the target, where it is `>=`. Without that exception a group of
byte-identical vectors never prunes itself: every member keeps every other member,
fills all `m0` slots with the group, and the group becomes a sink the walk enters and
cannot leave. Ours compared strictly everywhere, in both the forward selection and
the reverse link. Now `HnswRedundant` carries the rule and both callers use it,
which meant tracking the selected links' own scores alongside their ids.

The reverse link's sort is now stable for the same reason: the links a previous
heuristic kept arrive in its order, and a score tie must not reshuffle them or the
pairs it already cleared stop lining up with the both-processed skip.

**2. Rescore pool vs beam — fixed, and it was backwards.** All three engines agree on
this and we were the odd one out. Qdrant: `oversampled_top = oversampling * k`, then
`ef = max(hnsw_ef, oversampled_top)`. Elasticsearch, in `DenseVectorFieldMapper`:
`adjustedK = min(ceil(k * oversample), 10000)`, `numCands = max(adjustedK, numCands)`.
Ours *capped* the pool at the beam, which collapses two knobs into one: asking to
re-score 400 of a beam of 100 re-scored 100, and the recall the oversample was asked
for never arrived.

`sdb_hnsw_rerank_factor` now means what their knob means, including the `0`:
Elasticsearch accepts "greater than 1 or exactly 0" and reads 0 as no rescore, and
Qdrant says the same thing with `quantization.rescore: false`. The default is 3, which
is Elasticsearch's `DEFAULT_OVERSAMPLE`. What this replaced — a pool of the whole beam
— is still expressible as `ef/k`, and is not a default any of the three keeps.

Measured on sift-128-100k at k=10, m=16, ef_construction=128, sq8: factor 0 plateaus at
0.9904 however wide the beam (the codes' own ceiling, and where Qdrant's scalar default
sits); factor 1 reads the same, because re-scoring the top ten re-orders them but
cannot change which ten they are; factor 3 reaches 1.0000 at ef 1024. Before the fix,
factor 4 at ef 16 read 0.8717 against factor 1's 0.8683 — the beam was never widened,
so the oversample did almost nothing. After it, factor 4 reads the same 0.9666 at every
ef from 16 to 40, because all of them floor the beam at forty and all of them are
therefore the same search.

**3. Entry point: global maximum from the start vs running maximum — kept, ours.**
Qdrant assigns a level as each point arrives and keeps whichever point has the
highest level *so far* as the entry, so `linking_level = min(level, entry.level)`
truncates early points: a point drawn at level 5 while the running entry is at level 2
links only at levels 0..2, and its upper levels stay empty until something links back.
We assign every level up front, pick the segment's maximum, and insert against it, so
`min(top, entry_top) == top` always and every point links at every level it was drawn
for. Both are valid HNSW and both converge to the same entry once the maximum is
drawn; ours has strictly better upper-level connectivity in between. Matching theirs
would mean giving up the batch build for a streaming one to get a worse graph.

**4. Backlink timing — kept, ours.** Qdrant writes a level's backlinks before
searching the next level down; we defer all of them to the end of the insert. Level
`l`'s backlinks cannot affect a search at level `l-1`, so single-threaded the two are
identical. Concurrently they differ in what a neighbouring thread sees mid-insert,
which is nondeterministic in both.

**5. Order-zero quirk — not a difference.** Qdrant's `NonZeroU32::new(order)` turns
order 0 into `None`, so the first existing link always looks unprocessed and its
redundancy check is re-run. The check is known to pass, so this is wasted work, not a
different answer.

## Filtered search: deliberately not the same shape

Three differences here, all of them ours on purpose, and all of them reasons a
filtered comparison is between strategies rather than implementations.

- **Descent.** Qdrant filters during the descent: `score_points` discards rejected
  neighbours, so the walk down cannot pass through a non-matching region. Ours
  descends unfiltered, navigating only.
- **Level 0.** Qdrant's plain filtered search discards rejected neighbours entirely,
  which can disconnect the graph; its ACORN-1 path expands a rejected node's
  neighbours in its place. Our `prune` mode is their plain search and our `twohop` is
  ACORN-1; our default `through` passes through rejected nodes without admitting them,
  which neither of theirs does.
- **Entry point.** Qdrant keeps a pool of roughly `rows / full_scan_threshold * 10`
  high-level points and, for a filtered query, starts from the highest one that passes
  the filter — with no passing entry it returns nothing. We always start from the
  single global entry.

## Lucene, for the Elasticsearch rows

Read at `lucene/core/src/java/org/apache/lucene/util/hnsw/`. Same algorithm, three
differences worth knowing before reading an Elasticsearch row.

- **Level sample.** `ml = 1/ln(M)` and `level = (int)(-log(u) * ml)` — truncated, where
  Qdrant and we round. Lucene's levels are therefore lower on average for the same `M`,
  which is a slightly flatter graph, not a worse one. `M` is the upper-level width and
  level 0 gets `M * 2`, same split as the other two, and Elasticsearch's `m` is Lucene's
  `maxConn` directly, so `m: 16` means the same thing in all three.
- **Diversity.** `diversityCheck` drops a candidate when `bulkScore(...) >= score` —
  non-strict always, where Qdrant is non-strict only between exact ties and we now match
  Qdrant. On data without duplicates the three coincide; on duplicates Lucene and Qdrant
  both avoid the sink and, before this work, we did not.
- **The filtered walk is ours.** `searchLevel` adds a neighbour to `candidates` on score
  alone and to `results` only when `acceptOrds` passes it — it walks *through* rejected
  nodes rather than discarding them. That is our `through` mode, which we had taken for
  a SereneDB invention; Qdrant is the one doing something different, discarding in its
  plain path and bridging in ACORN-1.

Confirmed identical: the beam's admission tie (`score >= nextUp(minCompetitive)` is
`score > worst`, the same rule as the other two), the batch short-circuit (`bulkScore`
max against `minCompetitive` cannot admit anything the per-node test would not), and
marking visited at collection time, which is what we do and Qdrant does not.
