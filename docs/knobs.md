# Every HNSW knob the participants expose

Read off the engines themselves on 2026-09-16, not from documentation: Elasticsearch 9.5.4 by
probing which mapping and query parameters it accepts, Qdrant 1.19.1 from its client models.
This is the surface a fair comparison has to cover, because matching `m`, `ef_construction` and the
quantization is only the part that was easy.

## Build time

| knob | Elasticsearch | Qdrant | SereneDB |
|---|---|---|---|
| graph degree | `m` | `m` | `m` |
| build beam | `ef_construction` | `ef_construct` | `ef_construction` |
| quantization | `type`: `hnsw`, `int8_hnsw`, `int4_hnsw`, `bbq_hnsw`, `bbq_disk` | `scalar` / `binary` / `product` | `quant`: `none`, `sq8`, `sq4`, `pq`, `rabitq`, `tq` |
| quantizer range | `confidence_interval` (int8, int4) | `quantile` (scalar) | **none: global min/max** |
| default rescore pool | `rescore_vector.oversample` (int8, int4, bbq) | — | — |
| exact-search cutoff | — | `full_scan_threshold` | cost model, plus `sdb_hnsw_filter_mode = scan` |
| filtered-graph links | — | `payload_m` | — (rejected: post-filtering by another name) |
| segments | `number_of_shards` | `default_segment_number`, `max_segment_size` | one per index |
| residency | — | `on_disk`, `always_ram`, `memmap_threshold` | — |
| build threads | — | `max_indexing_threads` | — |
| disk-IVF cluster size | `cluster_size` (bbq_disk only) | — | IVF `posting_size` |

## Query time

| knob | Elasticsearch | Qdrant | SereneDB |
|---|---|---|---|
| beam | `num_candidates` | `hnsw_ef` | `sdb_hnsw_ef_search` |
| results | `k` | `limit` | `LIMIT` |
| rescore pool | `rescore_vector.oversample` | `quantization.oversampling` + `rescore` | `sdb_hnsw_rerank_factor` (added today) |
| skip rescoring | omit `rescore_vector` | `quantization.ignore` | factor 0 reads the whole beam |
| exact | `script_score` | `exact: true` | `sdb_ann_exact` |
| filtered strategy | chosen internally | `acorn` | `sdb_hnsw_filter_mode`: auto, scan, walk, prune, twohop, bridge |
| min score | `similarity` | `score_threshold` | radius form |
| graph visit cap | `visit_percentage` | — | — |
| indexed-only | — | `indexed_only` | — |

## What this says

**The beam and the rescore pool are separate knobs everywhere, and until today they were one knob
here.** Our pool was the whole beam, so a beam of 512 read 512 vectors back at full precision. At
1024 dimensions that is two megabytes a query, where an oversample of four at k=10 reads a hundred
and sixty kilobytes. That is not a tuning difference, it is a configuration the engine could not
express, and it is why Qdrant reaches a high recall from a narrow beam while we have to widen the
search to get there.

**We have no quantizer range knob.** Elasticsearch calls it `confidence_interval`, Qdrant calls it
`quantile`; both clip the outliers so the 8-bit range covers the bulk of the distribution instead of
the extremes. We train on global minimum and maximum, which is the worst case for an outlier-heavy
dimension. This is an index-time knob and a likely recall difference at the same bit width.

**Segment count is structural, not a knob we can match.** Qdrant defaults to eight segments and we
build one. That changes per-query parallelism and the size of every per-query filter structure. It
is worth stating in any result rather than pretending the builds are identical in every respect.

**Two knobs are theirs alone and both are filtered-search strategy**, `acorn` on Qdrant and
`visit_percentage` on Elasticsearch. Ours is `sdb_hnsw_filter_mode`. These are not matched and
cannot be; the fair thing is to let each engine use its best and say which it used.
