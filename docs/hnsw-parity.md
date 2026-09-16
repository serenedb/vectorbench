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

**2. Rescore pool vs beam — fixed, and it was backwards.** Qdrant has two knobs:
`quantization.oversampling` sizes a pool of `oversampling * k`, and the beam is then
*widened* to hold it (`ef = max(hnsw_ef, pool)`); `quantization.rescore` says whether
that pool is read back at full precision, and defaults to **false** for scalar
quantization and true for binary. Ours capped the pool at the beam, which collapses
the two knobs into one: asking to re-score 400 of a beam of 100 re-scored 100, so the
recall the oversample was asked for never arrived. Now a pool wider than the beam
raises `min_ef`, matching Qdrant exactly, and a new `sdb_hnsw_rescore` boolean
expresses their `rescore`. The mapping is now total in both directions — their
"re-score the whole beam" is our factor of 0 and is their `oversampling = ef/k`.

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

## Not read, still open

Lucene/Elasticsearch's graph and its `rescore_vector.oversample` path, to the same
depth. Until then the same caveat applies to any Elasticsearch row.
