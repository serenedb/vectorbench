# OpenSearch HNSW

HNSW through the OpenSearch k-NN plugin's `knn_vector` field, in the official container image,
single node, security plugin off, one shard. The matched build runs on the plugin's Lucene engine,
because faiss cannot produce eight-bit codes in 3.8; the faiss build is a separate run, below.

## What this participant declares

`settings.yml` builds an HNSW graph with `m: 16` and `ef_construction: 128`, matching the other HNSW
participants, and asks for `compression_level: 4x`, the plugin's one-byte-per-dimension codes.

That combination is only reachable through Lucene. Measured against 3.8, the engines do not accept
the same compression levels, and faiss has no byte step at all:

| compression | bits per dimension | faiss | lucene |
|---|---|---|---|
| 1x | 32, float | yes | yes |
| 2x | 16, fp16 | yes | no |
| 4x | 8, byte | **no** | **yes** |
| 8x | 4 | yes | no |
| 16x | 2 | yes | no |
| 32x | 1, binary | yes | yes |

So the matched build runs on Lucene. The faiss build is a separate run, because its nearest
quantizations are sixteen bits and four, neither of which is comparable to the eight bits the other
participants use:

```
vectorbench run --participant opensearch-hnsw --dataset <id> --index \
    --index-set engine=faiss --index-set compression_level=2x --label faiss
```

`load.py` reports the mapping it actually built as `mapping_variant`, and warns loudly on stdout if
the asked-for build was refused and it fell back, so a run that quietly became full precision cannot
be mistaken for a matched one.

## Rescoring

Every approximate block asks for `rescore` and carries `oversample_factor` as a second ladder knob.
Without it the search answers from the 8-bit codes alone and recall stops well short of one however
wide the beam: on a 20 thousand row probe it sat at 0.812 with rescoring off and 0.999 with it on.
Elasticsearch and Qdrant have the same cliff and are configured the same way.

The beam knob is `ef_search`, passed per query as `method_parameters` so the index setting stays off
the measured path, and the plugin floors it at `k`. On a 200 thousand row probe it moved recall from
0.665 to 0.885, so the ladder is live; on a 20 thousand row one it did nothing, because a graph that
small is searched almost exhaustively.

## Filtering

Every filtered group passes the predicate as the `filter` of the `knn` query, which is the plugin's
pre-filter: OpenSearch decides by itself whether to answer it exactly, by an ACORN-style traversal,
or by a post-filter, and the plan check records which query actually ran. See
[../docs/algorithms.md](../docs/algorithms.md).

## Exact groups

The exact rows use `script_score` with the plugin's `knn_score` script over the same filter, which is
what OpenSearch documents as exact k-NN. The plan rule requires that no k-NN graph query appears, so
an exact row that silently used the graph cannot be published.

## Notes

- `_source` is disabled and the dataset id is the document `_id`, so a hit carries nothing but that
  id and the score.
- Ingest sets `refresh_interval: -1` and async translog durability, then refreshes, waits for merges
  to stop, and calls the plugin's warmup endpoint. The plugin loads a native graph lazily on first
  search, and without the warmup that load would land inside the first measured query.
- `install` refuses to run when `vm.max_map_count` is below 262144, which is the limit the JVM needs
  to mmap its segments.
- The heap is `env.heap` in `settings.yml`, 32g by default. Lucene and faiss want the rest of the
  machine's memory, so do not raise it much.
