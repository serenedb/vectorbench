-- SereneDB IVF: one block per group (docs/contracts.md section 5). All statements but the last are
-- setup, run once per point on every connection; the last is the query. {nprobe} comes from the
-- ladder; $q $k $v $lo $hi $s are bound per query by client.py.

-- group: none/*
SET sdb_ivf_search_nprobe = {nprobe};
SELECT id FROM {index.relation} ORDER BY emb <#> $q LIMIT $k;

-- group: exact/none/*
-- Exact: the engine's own brute force (sdb_ann_exact), every stored vector scored, split across workers.
SET sdb_ann_exact = on;
SELECT id FROM {index.relation} ORDER BY emb <#> $q LIMIT $k;

-- group: eq-10/*
SET sdb_ivf_search_nprobe = {nprobe};
SELECT id FROM {index.relation} WHERE cat10 = $v ORDER BY emb <#> $q LIMIT $k;

-- group: eq-1/*
SET sdb_ivf_search_nprobe = {nprobe};
SELECT id FROM {index.relation} WHERE cat100 = $v ORDER BY emb <#> $q LIMIT $k;

-- group: exact/eq-1/*
SET sdb_ann_exact = on;
SELECT id FROM {index.relation} WHERE cat100 = $v ORDER BY emb <#> $q LIMIT $k;

-- group: eq-0.1/*
SET sdb_ivf_search_nprobe = {nprobe};
SELECT id FROM {index.relation} WHERE cat1000 = $v ORDER BY emb <#> $q LIMIT $k;

-- group: range-10/*
SET sdb_ivf_search_nprobe = {nprobe};
SELECT id FROM {index.relation} WHERE num BETWEEN $lo AND $hi ORDER BY emb <#> $q LIMIT $k;

-- group: range-1/*
SET sdb_ivf_search_nprobe = {nprobe};
SELECT id FROM {index.relation} WHERE num BETWEEN $lo AND $hi ORDER BY emb <#> $q LIMIT $k;

-- group: and-1/*
SET sdb_ivf_search_nprobe = {nprobe};
SELECT id FROM {index.relation} WHERE cat10 = $v AND num BETWEEN $lo AND $hi ORDER BY emb <#> $q LIMIT $k;

-- group: corr/*
SET sdb_ivf_search_nprobe = {nprobe};
SELECT id FROM {index.relation} WHERE cluster = $v ORDER BY emb <#> $q LIMIT $k;

-- group: xcorr/*
SET sdb_ivf_search_nprobe = {nprobe};
SELECT id FROM {index.relation} WHERE cluster = $v ORDER BY emb <#> $q LIMIT $k;

-- group: lang/*
SET sdb_ivf_search_nprobe = {nprobe};
SELECT id FROM {index.relation} WHERE lang = $s ORDER BY emb <#> $q LIMIT $k;

-- group: xlang/*
SET sdb_ivf_search_nprobe = {nprobe};
SELECT id FROM {index.relation} WHERE lang = $s ORDER BY emb <#> $q LIMIT $k;
