# SereneDB HNSW

Participant `serenedb-hnsw-quant`: [SereneDB](https://github.com/serenedb/serenedb) with an `hnsw`
vector index inside its inverted index, queried in SQL over the Postgres wire protocol.

| | |
|---|---|
| Image | `serenedb/serenedb:26.11.1` (`settings.yml: env.image`). `install` pulls it only when the tag is not present locally, so a locally built image under that tag is used as is. `VB_BINARY` runs a native `serened` instead. |
| Port | `127.0.0.1:5500`, host networking |
| Client | psycopg 3, binary protocol, one connection per client process |
| Table | `items` with `storage = 'search'`: the rows live in the inverted index together with the vector index |
| Container | `vectorbench-serenedb-hnsw-quant`, optional `--cpuset-cpus` and `--memory` (no swap), storage bind-mounted at `/var/lib/serenedb`, the prepared shards mounted read-only |

## Load recipe (`load` -> `load.py`)

1. `CREATE TABLE items (...) WITH (storage = 'search')`.
2. `CREATE INDEX items_vec ON items USING inverted(id, cat10, cat100, cat1000, num, cluster, lang,
   emb hnsw (metric = 'ip', quant = ..., compression = false, m = 16, ef_construction = 256))`. The
   attribute columns are index key columns, so a predicate is answered inside the scan
   (`Index Filter:` in EXPLAIN).
3. `INSERT INTO items SELECT ... FROM read_parquet(shard)` for every shard, then `VACUUM (REFRESH_TABLE)`.
4. Background compaction off (`compaction_interval = 0`), wait for the merges in flight, then
   `VACUUM (COMPACT_TABLE)` down to the configured segment count (8), and poll `sdb_metrics` until no
   compaction is active or pending and the segment count has been stable for six 5-second polls.

Phases reported: `ddl`, `ingest`, `compaction`. Info reported: rows, segments, files, index bytes,
the DDL.

## What `data-size` counts

`du -sb --exclude=wal /var/lib/serenedb` inside the container: table, indexes and catalog.

## Index configuration per size

| size | codes | float vectors | rescoring |
|---|---|---|---|
| `wiki-v3-1024-247m` | `quant = 'tq'`, `nb_bits = 2` (TurboQuant, 2 bits per dimension), in RAM | 1 TB on disk, uncompressed (`compression = false`) | yes, swept by `width` |
| `wiki-v3-1024-10m` | `quant = 'usq8'` (8-bit scalar), in RAM | in RAM | none (`width = 0`) |

Both: `m = 16`, `ef_construction = 256`, 8 segments.

## Queries (`queries.sql`) and knobs

One block per group; every statement but the last runs once per point on every connection.

| knob | setting | meaning |
|---|---|---|
| `ef` | `sdb_hnsw_ef_search` | the beam of the graph walk, on quantized codes |
| `width` | `sdb_ann_rescore_width` | a candidate from any segment is reread at full precision while its code score plus `width` times the code's estimated error could still beat the k-th full-precision score found so far; 0 answers from the codes |
| `mode` | `sdb_hnsw_filter_mode` | `auto`: per segment, score the rows that pass the filter directly when they are few, otherwise walk the graph and admit only rows the filter passes |

Exact groups set `sdb_ann_force_exact = on`: every stored vector, or every row the `WHERE` admits,
is scored, with each segment split across workers. EXPLAIN shows `Exact:`.

`plan_rules` in `settings.yml` check every group's plan before it is measured: `IRESEARCH_SCAN`
always, `Score:` for approximate groups, `Index Filter` or `Column Filter` for filtered groups,
`Exact:` for exact ones.

## Facts that are not in the code

- **The metric must match.** The index is used only when the query operator's metric equals the
  index metric; `client.py` rewrites the operator in `queries.sql` (`<#>` inner product, `<->` l2)
  from the family's metric.
- **Startup includes the first vector query.** `start` launches a background prewarm that waits for
  the server and runs one 10-NN query; `check` succeeds only after it. That query loads every
  segment's graph and codes, so startup is the time until the engine can answer a vector search.
- **Eviction.** The server memory-maps the column files it reads (`.col`), and `drop_caches` cannot
  free pages a process maps; `evict_mapped: [.col]` lets `--evict` page them out of the server's
  mappings. Graphs and codes live in the server's heap and stay.
- **One container per dataset size.** `start` resumes an existing container only if it mounts this
  dataset's storage; one left by another size is replaced.
