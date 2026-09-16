# Elasticsearch HNSW

Lucene's HNSW through Elasticsearch's `dense_vector` field, in the official container image, single
node, security off, one shard.

## What this participant declares

`settings.yml` builds `int8_hnsw` with `m: 16` and `ef_construction: 128`, matching the other HNSW
participants, and asks for a rescore oversample of 3.0. Lucene keeps the full precision vectors
alongside the quantized ones, so the rescore reads them directly.

The ladder knob is `num_candidates`, which is Lucene's beam and also its result ceiling: a search
cannot return more than `num_candidates` hits, so the k=100 and k=1000 groups carry their own ladders
starting at k. Elasticsearch's own default is `min(1.5k, 10000)`; the ladder overrides it per point.

## Filtering

Every filtered group passes the predicate as the `filter` of the `knn` clause, which is
Elasticsearch's pre-filter: the filter is evaluated first and the graph search only admits documents
that pass. Elasticsearch decides by itself whether to answer a filtered query exactly, and Lucene
decides again inside the graph search whether to use its ACORN-style searcher; see
[../docs/algorithms.md](../docs/algorithms.md). Those decisions are the engine's, not ours, and the
plan check records which query Lucene actually ran.

## Exact groups

The exact rows use `script_score` over the same filter with a `dotProduct` or `l2norm` script, which
is what Elasticsearch documents as exact kNN. The plan rule requires that no `Knn` query appears, so
an exact row that silently used the graph cannot be published.

## Notes

- `_source` is disabled and the dataset id is the document `_id`, so a hit carries nothing but that
  id and the score. Anything else would measure Elasticsearch's source fetching rather than its
  vector search.
- Ingest sets `refresh_interval: -1` and async translog durability, then refreshes once and waits for
  merges to stop. Load time therefore covers ingest plus the index settling, as with every other
  participant.
- The heap is `env.heap` in `settings.yml`, 32g by default. Lucene wants the rest of the machine's
  memory for the page cache, so do not raise it much.
