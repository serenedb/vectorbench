# Elasticsearch HNSW

Participant `elasticsearch-hnsw`: Lucene's HNSW through Elasticsearch's `dense_vector` field, in the
official container image, single node, security off, one shard merged to 8 segments.

| | |
|---|---|
| Image | `docker.elastic.co/elasticsearch/elasticsearch:9.5.6` (`settings.yml: env.image`). `install` pulls it only when the tag is not present locally. |
| Port | `127.0.0.1:9200`, host networking |
| Client | plain HTTP over one kept-alive connection per client process, `_source` off, the dataset id from doc values |
| Index | `items`: one `dense_vector` field `emb`, the attribute columns as keyword (`cat10`, `cat100`, `cat1000`, `cluster`, `lang`) and integer (`num`) fields |
| Container | `vectorbench-elasticsearch-hnsw`, heap 31g (`env.heap`), optional `--cpuset-cpus` and `--memory` (no swap), storage bind-mounted at `/usr/share/elasticsearch/data` |

## Load recipe (`load` -> `load.py`)

1. A fresh index with refresh off and asynchronous translog durability, one shard, no replicas,
   `index.dense_vector.hnsw_filter_heuristic` set explicitly (`acorn` by default, Elasticsearch's own
   default for new indexes).
2. `similarity: dot_product` when the vectors are unit length, which is Elasticsearch's choice for
   normalized vectors; `max_inner_product` otherwise, `l2_norm` for l2 families.
3. Bulk ingest in batches of 500 documents from `VB_LOAD_WORKERS` processes (24 by default), one
   per dataset file at a time. Merges run unthrottled (`merge.scheduler.auto_throttle: false`) with
   `intra_merge_parallelism_enabled`, and `max_merged_segment` is sized so 8 segments hold the shard.
4. `_forcemerge` to 8 segments, then wait until the segment count is stable and no merge runs.

Phases reported: `ingest`, `index`. `VB_LOAD_LIMIT_ROWS` loads only the first N rows, for a pilot.

## Index configuration per size

| size | `index_options.type` | codes | rescore |
|---|---|---|---|
| `wiki-v3-1024-10m` | `int8_hnsw` | 8-bit scalar, in RAM | none (`oversample: 0`) |
| `wiki-v3-1024-247m` | `bbq_hnsw` | 1-bit BBQ, in RAM | `ceil(k x oversample)` candidates reread from disk |

Both: `m = 16`, `ef_construction = 256`, 8 segments. Elasticsearch 9.5.6 offers HNSW only as float,
`int8_hnsw`, `int4_hnsw` or `bbq_hnsw` (1 bit); its 2-bit codes exist only in `bbq_disk`, an IVF
index. At 247M only 1-bit codes fit in RAM next to the graph (8-bit would take 253 GB, 4-bit 126 GB).

## Queries (`queries.json`) and knobs

| knob | parameter | meaning |
|---|---|---|
| `num_candidates` | `knn.num_candidates` | the beam of the graph walk in every segment; Elasticsearch floors it at k, and at `ceil(k x oversample)` when rescoring |
| `oversample` | `knn.rescore_vector.oversample` | `0` answers from the codes; `>= 1` rereads the shard's best `ceil(k x oversample)` candidates at full precision, once per shard, not per segment |

Filtered groups pass the predicate as the `filter` of the `knn` clause: the filter is evaluated
first and the graph walk admits only documents that pass, with ACORN deciding the walk below its own
selectivity threshold. Exact groups use `script_score` over the same filter, which is what
Elasticsearch documents as exact kNN; `plan_rules` require that no `Knn` query appears there.

## Facts that are not in the code

- **Keyword for equality fields.** Elasticsearch documents term queries on `keyword` as faster than
  on numeric fields, so the equality-only attributes are keyword; `num` takes ranges and stays integer.
- **Eviction.** Lucene memory-maps its files; `evict_mapped: [.vec]` pages the full-precision vector
  files out of the server's mappings. The graph (`.vex`) and the codes stay in RAM.
- **Heap.** 31g keeps compressed object pointers; the rest of RAM is Lucene's page cache, where the
  graph and codes live.
