# OpenSearch HNSW

faiss HNSW through the OpenSearch k-NN plugin's `knn_vector` field, in the official container image,
single node, security plugin off, one shard.

## What this participant declares

`settings.yml` builds an HNSW graph with `m: 16` and `ef_construction: 128`, matching the other HNSW
participants, and asks for `mode: in_memory` with `compression_level: 4x`, which is the plugin's
one-byte-per-dimension quantization.

The k-NN plugin has changed how quantization is declared more than once, so `load.py` tries three
field mappings in order and uses the first the server accepts:

| variant | what it builds | matched? |
|---|---|---|
| `mode+compression` | byte codes with the declared graph parameters | yes |
| `sq-encoder` | faiss `fp16`, which is 2x not 4x | no |
| `method-only` | full precision | no |

Which one ran is recorded as `mapping_variant` in the result file, together with the field mapping
the server reports back, so a run that fell to a different build cannot be mistaken for a matched
one.

The ladder knob is `ef_search`, faiss's beam, passed per query as `method_parameters` so the index
setting stays out of the measured path. The plugin floors it at k, so the k=100 and k=1000 groups
carry their own ladders starting at k.

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
