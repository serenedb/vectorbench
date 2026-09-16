# What the engines actually do

Every participant here answers the same question, "the k nearest vectors, optionally filtered", and
every one of them uses HNSW to do it. The numbers in the results table come from the places where
their answers differ. This document is that list, read out of each engine's source: SereneDB
(`iresearch/formats/hnsw`, `iresearch/search/queries/hnsw_query.cpp`), Qdrant
(`lib/segment/src/index/hnsw_index`), Elasticsearch through Lucene
(`lucene/core/.../hnsw`, plus Elasticsearch's own query layer), and OpenSearch through faiss
(`faiss/impl/HNSW.cpp`, plus the k-NN plugin's `KNNWeight` and JNI layer).

The graph itself is the least interesting part. All four assign levels from the same exponential
draw, all four prune neighbours with the same diversity heuristic from the HNSW paper, and all four
descend greedily through the upper levels before running a beam search at level 0. The differences
that matter are in what happens around the graph: how a filter reaches the traversal, whether the
engine ever abandons the graph for a scan, what quantized distances are reranked against, and how
many cores answer one query.

## At a glance

| | SereneDB | Qdrant | Elasticsearch (Lucene) | OpenSearch (faiss) |
|---|---|---|---|---|
| default m / level 0 | 32 / 2m | 16 / 2m | 16 / 2m | 16 / 2m (plugin) |
| default build beam | 200 | 100 | 100 | 100 (plugin) |
| default search beam | 64 | = ef_construct | k (num_candidates) | 100 (plugin) |
| filter reaches traversal as | folded bitset | closure per candidate | AcceptDocs bits | IDSelector bitmap or batch |
| rejected nodes still expanded | yes (`Through`), configurable | no | yes | yes |
| abandons the graph for a scan | yes, by cost model | yes, by cardinality estimate | yes, two rules | yes, by absolute count |
| extra links per filter value | no | yes (`payload_m`) | no | no |
| quantized search reranked | always, the beam | binary only by default | opt in, oversample 3.0 | always, oversample by dims |
| one query uses | one core per segment | every segment in parallel | every segment in parallel | every segment in parallel |

## The graph, where they agree

Level assignment is `-ln(u) / ln(m)` in all four. Level 0 holds twice the links of the upper levels
in all four. Neighbour selection is the paper's diversity rule in all four: walking candidates
nearest first, keep one only if it is closer to the inserted point than to any neighbour already
kept. faiss shrinks an overflowing list to 80% of capacity rather than to exactly the limit, to stop
the next insert from re-pruning immediately. Lucene skips building a graph at all for segments below
100 vectors. Those are the only build-side differences worth naming.

## Filtered search, where they do not

This is the axis that separates them.

**SereneDB folds the predicate into a bitset and then chooses a plan.** The `WHERE` is claimed into
the vector query, either as an inner index query or as a foldable filter over the columnstore, and
both fold into one `LazyBitset`. The search then picks between walking and scanning by comparing
their costs: a walk costs about `ef * m0 * nodes / matches` distance computations, a scan costs one
per match. Whichever is cheaper wins, and any walk carries a budget equal to the match count, so a
predicate too sparse for the graph falls back to the scan rather than degenerating. Four walk modes
exist for the cases where walking wins: `Through` passes through rejected nodes and admits only what
the predicate passes, `Prune` expands only admitted nodes, `TwoHop` stands a rejected node's admitted
neighbours in for it, and `Bridge` crosses a rejected node for exactly one hop.

**Qdrant builds a second set of links per filter value.** With `payload_m` set, and it defaults to
the main `m` when a payload index exists, Qdrant builds a small HNSW graph over just the points
matching each indexed payload value and merges those links into the same per-point link lists as the
main graph. A filtered query therefore walks a graph that is already dense in the matching subset,
with no separate subgraph to select at query time. Blocks that percolation sampling judges already
well connected are skipped unless the field is marked as a tenant key. On top of that Qdrant
estimates the filter's cardinality, from index statistics with a sampled Agresti-Coull interval to
break ties, and runs a plain scan instead when the estimate is below `full_scan_threshold`, which is
configured in kilobytes and divided by the average vector size to get a point count. ACORN-style
two-hop traversal exists but is off by default.

**Lucene decides twice, and has an ACORN-1 searcher.** First, if the filter's cost is at most the
per-leaf k, it runs an exact scan immediately, on the reasoning that the graph would have to visit
that many nodes anyway. Otherwise it runs the graph with a visit limit of the filter cost plus one,
and if the search hits that limit or returns too few hits, it redoes the leaf exactly. Second, inside
the graph search, if fewer than 60% of documents pass the filter it switches to a filtered searcher
that expands to neighbours of neighbours when too many candidates are rejected. Elasticsearch layers
`num_candidates` on top, defaulting to `min(1.5k, 10000)`, and pre-filters by default.

**faiss does not adapt at all, and OpenSearch decides by absolute count.** In faiss the `IDSelector`
gates admission to the result heap only. Rejected nodes are still marked visited and still pushed onto
the candidate heap, so the walk uses them as stepping stones, and the identical code path runs whether
the filter passes 1% or 99% of ids. Every strategy choice comes from the k-NN plugin above it, which
decides per segment: exact if the filtered document count is at most k, exact if a configured
threshold says so, and otherwise exact if `filteredCount * dimensions` is at most 2,048,000 distance
computations. That is an absolute budget, not a fraction of the corpus, so the same filter switches
strategy at 2000 documents at 1024 dimensions and at 16000 at 128. If the approximate search then
returns fewer than k hits, the leaf is redone exactly. The filter reaches faiss as a bitmap or as an
array of ids, chosen on memory cost rather than on selectivity.

## Quantization and reranking

**SereneDB** offers `none`, `sq8`, `sq4`, `pq`, `rabitq` and `tq`. The graph scores quantized codes
and always reranks the beam against the stored vectors, so the beam is both the search width and the
rerank pool. `none` carries a PCA rotation and Panorama level norms, which give bounded early
termination; `pq`, `rabitq` and `tq` use faiss's fast-scan blocked layout; `sq8` and `sq4` are
row-major with neither.

**Qdrant** offers scalar int8, binary at 1, 1.5 or 2 bits, product quantization, and TurboQuant.
Rescoring against the original vectors is on by default for binary and off for scalar and product.
Oversampling defaults to 1, meaning the pre-rescore pool is exactly k unless a request asks for more.

**Lucene** stores quantized bytes with per-vector correction terms and always keeps the full
precision vectors in a separate file alongside. Elasticsearch's BBQ is the asymmetric 1-bit scheme,
and it rescores with an oversample factor defaulting to 3.0 for BBQ, capped at 10000 candidates.

**faiss** puts the quantizer in as the graph's storage, so traversal distances are already
approximate, and it never rescores on its own. Full precision refinement requires wrapping the index
in `IndexRefine`, which fetches `k * k_factor` candidates and recomputes exact distances. **OpenSearch**
supplies that layer itself: scalar fp16 by default, 1, 2 or 4 bit scalar and binary below that, and a
rescore against full precision vectors whose oversample factor is chosen from the dimensionality when
the user does not set one, 1.0 at 1000 dimensions or more, 2.0 from 768, and 3.0 below that, with the
first pass clamped to between 100 and 10000 candidates.

### What the engines actually did when asked

Probed on throwaway containers before any of them ran a measurement, because the documented
defaults did not survive contact.

**None of the three reorders unless told to, per query.** Every one of them answers from the
quantized codes, so recall stops short of one no matter how wide the beam, and any bar above that
ceiling is unreadable rather than lost.

| engine | ceiling without reordering | the knob |
|---|---|---|
| OpenSearch, Lucene 4x | recall 0.812, against 0.999 with it on | `rescore: {oversample_factor: N}` |
| Qdrant, scalar 8-bit | recall 0.9695 at k=10, 0.9847 at k=1000 | `params.quantization: {rescore, oversampling}` |
| Elasticsearch, int8 | declared an oversample no query carried | `rescore_vector: {oversample: N}`, per query |

The Elasticsearch case is worth separating: the oversample is a search parameter, not an index
option, so declaring it where the mapping is built has no effect at all.

**OpenSearch's two engines do not accept the same compression levels**, and the gap lands exactly on
the width everyone else uses:

| compression | bits per dimension | faiss | lucene |
|---|---|---|---|
| 1x | 32, float | yes | yes |
| 2x | 16, fp16 | yes | no |
| 4x | 8, byte | no | yes |
| 8x | 4 | yes | no |
| 16x | 2 | yes | no |
| 32x | 1, binary | yes | yes |

So a matched eight-bit build on OpenSearch runs on Lucene, and the faiss build is a different
quantization by necessity rather than by choice.

## Segments, and how many cores answer one query

**Qdrant** splits a shard into segments, defaulting to CPU count over two clamped to between 2 and 8,
and fans one query out over all of them concurrently before merging. **Lucene** keeps one graph per
segment and Elasticsearch searches leaves concurrently by default above a minimum slice size.
**OpenSearch** keeps one native graph per Lucene segment, rebuilt from scratch at merge rather than
carried over, searches leaves concurrently, and adds a two-pass strategy of its own: after a first
pass over every segment it computes the global k-th score and only re-searches the segments whose
worst hit already clears it.

**SereneDB compacts a search table to a single segment**, so one query is one graph walk on one core.
Parallelism within a segment exists only for the scan paths, where the doc range splits across
workers sized by the scan's fair share of the machine. This is the structural difference behind most
of the remaining filtered-latency gaps: where the others answer a filtered query on eight cores,
SereneDB answers it on one unless the plan is a scan.

## Deletes

Most of them soft-delete and mask at collection time, which keeps the graph traversable but leaves
dead edges in it. They differ in when they repair. Qdrant rebuilds a segment when the deleted ratio
passes 0.2, and heals rather than rebuilds when at most 30% of points are missing, reconnecting the
border of the deleted subgraph with the same pruning heuristic. Lucene reuses the largest clean graph
as a merge base, will accept one with up to 40% deletions, drops edges to deleted ordinals, then
repairs nodes that lost 15% of their neighbours and rebalances the level distribution. SereneDB masks
at collection time and rebuilds on merge.

OpenSearch is the exception and it is worth naming: with no filter clause its graph traversal is
delete-unaware, and deleted documents are removed from the result after the search returns. That is a
post-filter, so recall falls under heavy deletes with nothing widening the search to compensate. With
a filter present, live documents are combined into the filter bitset first, so the problem does not
arise. This benchmark measures no deletes, so none of this shows up in the numbers.

## What this means for the results

Three of the differences above account for most of what the table shows.

1. **Payload-aware links.** Qdrant's filtered searches walk a graph built for the filter. SereneDB's
   walk the general graph and compensate by switching to an exact scan when the predicate is
   selective. That is why SereneDB's filtered rows show recall 1.0 at a fixed cost while Qdrant's
   show a recall ladder.
2. **Cores per query.** Qdrant, Elasticsearch and OpenSearch all spread one query over segments.
   SereneDB spreads only scans, and only within one segment.
3. **Rerank policy.** SereneDB always reranks the beam against stored vectors, so its quantized
   builds lose almost nothing to quantization. Qdrant does not rerank scalar quantization by default,
   and faiss does not rerank at all without an explicit wrapper.

Comparisons are only meaningful when the builds match. Both HNSW participants here declare m 16,
ef_construction 128 and scalar 8-bit quantization for that reason. Segment counts are left as each
engine chooses them, because that is engine policy rather than a graph parameter.
