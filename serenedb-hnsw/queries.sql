-- SereneDB HNSW: one block per group (docs/contracts.md section 5). All statements but the last are
-- setup, run once per point on every connection; the last is the query. {ef} and {rerank} come from
-- the ladder; $q $k $v $lo $hi $s are bound per query by client.py.
--
-- {rerank} is the rescore pool as a multiple of k: Qdrant's quantization.oversampling and
-- Elasticsearch's rescore_vector.oversample. The beam is walked on quantized codes and
-- ceil(rerank * k) of its hits are read back at full precision, with the beam widened to hold the
-- pool when the pool is the wider of the two, and 0 answering from the codes alone. All three
-- engines spell it the same way; docs/hnsw-parity.md has the reading.

-- group: none/*
SET sdb_hnsw_ef_search = {ef};
SET sdb_hnsw_oversample = {oversample};
SELECT id FROM {index.relation} ORDER BY emb <#> $q LIMIT $k;

-- group: exact/none/*
-- Exact: the engine's own brute force (sdb_ann_exact), every stored vector scored, split across workers.
SET sdb_ann_exact = on;
SELECT id FROM {index.relation} ORDER BY emb <#> $q LIMIT $k;

-- group: eq-10/*
SET sdb_hnsw_ef_search = {ef};
SET sdb_hnsw_oversample = {oversample};
SET sdb_hnsw_filter_mode = '{mode}';
SELECT id FROM {index.relation} WHERE cat10 = $v ORDER BY emb <#> $q LIMIT $k;

-- group: eq-1/*
SET sdb_hnsw_ef_search = {ef};
SET sdb_hnsw_oversample = {oversample};
SET sdb_hnsw_filter_mode = '{mode}';
SELECT id FROM {index.relation} WHERE cat100 = $v ORDER BY emb <#> $q LIMIT $k;

-- group: exact/eq-1/*
SET sdb_ann_exact = on;
SELECT id FROM {index.relation} WHERE cat100 = $v ORDER BY emb <#> $q LIMIT $k;

-- group: eq-0.1/*
SET sdb_hnsw_ef_search = {ef};
SET sdb_hnsw_oversample = {oversample};
SET sdb_hnsw_filter_mode = '{mode}';
SELECT id FROM {index.relation} WHERE cat1000 = $v ORDER BY emb <#> $q LIMIT $k;

-- group: range-10/*
SET sdb_hnsw_ef_search = {ef};
SET sdb_hnsw_oversample = {oversample};
SET sdb_hnsw_filter_mode = '{mode}';
SELECT id FROM {index.relation} WHERE num BETWEEN $lo AND $hi ORDER BY emb <#> $q LIMIT $k;

-- group: range-1/*
SET sdb_hnsw_ef_search = {ef};
SET sdb_hnsw_oversample = {oversample};
SET sdb_hnsw_filter_mode = '{mode}';
SELECT id FROM {index.relation} WHERE num BETWEEN $lo AND $hi ORDER BY emb <#> $q LIMIT $k;

-- group: and-1/*
SET sdb_hnsw_ef_search = {ef};
SET sdb_hnsw_oversample = {oversample};
SET sdb_hnsw_filter_mode = '{mode}';
SELECT id FROM {index.relation} WHERE cat10 = $v AND num BETWEEN $lo AND $hi ORDER BY emb <#> $q LIMIT $k;

-- group: corr/*
SET sdb_hnsw_ef_search = {ef};
SET sdb_hnsw_oversample = {oversample};
SET sdb_hnsw_filter_mode = '{mode}';
SELECT id FROM {index.relation} WHERE cluster = $v ORDER BY emb <#> $q LIMIT $k;

-- group: xcorr/*
SET sdb_hnsw_ef_search = {ef};
SET sdb_hnsw_oversample = {oversample};
SET sdb_hnsw_filter_mode = '{mode}';
SELECT id FROM {index.relation} WHERE cluster = $v ORDER BY emb <#> $q LIMIT $k;

-- group: lang/*
SET sdb_hnsw_ef_search = {ef};
SET sdb_hnsw_oversample = {oversample};
SET sdb_hnsw_filter_mode = '{mode}';
SELECT id FROM {index.relation} WHERE lang = $s ORDER BY emb <#> $q LIMIT $k;

-- group: xlang/*
SET sdb_hnsw_ef_search = {ef};
SET sdb_hnsw_oversample = {oversample};
SET sdb_hnsw_filter_mode = '{mode}';
SELECT id FROM {index.relation} WHERE lang = $s ORDER BY emb <#> $q LIMIT $k;
