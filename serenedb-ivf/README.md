# SereneDB IVF

SereneDB with an `ivf` vector index inside its inverted index (`USING inverted(..., emb ivf (...))`).
The sibling participant `serenedb-hnsw/` shares every script through symlinks and differs only in
`settings.yml` (index kind, ladder) and `queries.sql`.

## Image and prerequisites

- `serenedb/serenedb:26.09.1` from Docker Hub (see `settings.yml: env.image`). `./install` pulls only
  when the tag is not present locally, so a locally built image tagged the same way is used as is.
- Docker with access for the current user; Python from the repository's `.venv` (psycopg).
- No `psql` needed: every SQL round trip goes through psycopg.

## Recipe (`./load`)

1. `CREATE TABLE items (...) WITH (storage = 'search', compaction_interval = 0)`: rows live in the
   index, background compaction is off so the settle step controls it.
2. `CREATE INDEX items_vec ON items USING inverted(id, cat10, cat100, cat1000, num, cluster, lang,
   emb ivf (metric = ..., quant = ...))`: attribute columns are index key columns, so a predicate is
   answered inside the scan (`Index Filter:` in EXPLAIN).
3. `INSERT INTO items SELECT ... FROM read_parquet(shard)` per shard, then `VACUUM (REFRESH_TABLE)`.
4. `VACUUM (COMPACT_TABLE)`, then poll `sdb_metrics` until `compaction_active + compaction_pending = 0`
   and `num_segments` has not changed for six 5-second polls.

Phases reported: `ddl`, `ingest`, `compaction`. Info reported: rows, segments, files, index bytes
(`sdb_metrics.index_size`), the DDL.

## What data-size counts

`du -sb --exclude=wal /var/lib/serenedb` inside the container: table plus index plus catalog.

## Index configuration and ladder

`settings.yml`: `quant: sq8`, `posting_size: 1024` (`sdb_ivf_posting_size`, build time),
`sample_factor: 0.2` (`sdb_ivf_sample_factor`, build time). The search knob is `nprobe`
(`SET sdb_ivf_search_nprobe`), ladders per dataset size in `settings.yml`.

## Facts that are not in the code

- The index is used only when the query operator's metric equals the index metric; a mismatch falls
  back silently to a scan. `client.py` rewrites the operator from `VECTORBENCH_METRIC`.
- Everything is per segment (centroid tree, rerank). Recall and latency depend on the segment count,
  which is why `load` compacts and reports `segments`.
- `sdb_rerank_factor` (default 4.0) sets the exact-rescoring pool to `factor * k` for quantized IVF
  indexes. HNSW ignores it: its beam (`sdb_hnsw_ef_search`, floored at k) is the rescoring pool, so
  `ef` alone trades recall for time.
- `compression = false` in both opclasses stores the index's raw vectors uncompressed, so rescoring
  and exact reads skip the columnstore codec (ALP on FLOAT[N]) at the price of disk.
- `exact` groups set `sdb_ann_exact = on`: the engine scores every stored vector (or every row the
  WHERE admits) instead of walking the index, splitting each segment across the scan's workers;
  EXPLAIN shows `Exact: brute force over the stored vectors`. This is the same brute-force mode
  Qdrant's `exact = true` provides.
- HNSW with a WHERE (`sdb_hnsw_filter_mode`, default `auto`): the predicate folds into one bitset (the
  claimed index filter plus column predicates on stored columns); a selective one is answered by
  scoring its rows directly, otherwise the graph walk scores every neighbour and admits only rows the
  bitset passes. `scan`, `walk`, `prune` and `twohop` force one path.
- A numeric range whose finest trie level would expand to more than 1024 terms is left to the
  column filter (`Column Filter:` in EXPLAIN) instead of a granular-range term union. The predicate
  is then evaluated by the columnstore as the filter bitset fills, once per row per query.
- The shipped docs lag the code: the GUC is `sdb_ivf_search_nprobe` (not `sdb_nprobe`), and there is
  no `nlist` option; cluster count follows from `posting_size`.

## Version history

| version | measured | dataset | notes |
|---|---|---|---|
