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
- `sdb_rerank_factor` (default 4.0) sets the exact-rescoring pool to `factor * k` for quantized
  indexes; at k = 1000 that is 4,000 raw-vector reads per query.
- `exact` groups use `SET sdb_disable_top_k_optimization = true` on the same index: the engine's own
  streaming oracle path.
- The shipped docs lag the code: the GUC is `sdb_ivf_search_nprobe` (not `sdb_nprobe`), and there is
  no `nlist` option; cluster count follows from `posting_size`.

## Version history

| version | measured | dataset | notes |
|---|---|---|---|
