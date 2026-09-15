-- SereneDB HNSW: one block per group (docs/contracts.md section 5). HNSW refuses filtered search on
-- SereneDB main today (ERRCODE_FEATURE_NOT_SUPPORTED), so only the unfiltered groups are declared;
-- the filtered section reads `unsupported` until filtered HNSW lands.

-- group: none/*
SET sdb_hnsw_ef_search = {ef};
SELECT id FROM {index.relation} ORDER BY emb <#> $q LIMIT $k;

-- group: exact/none/*
-- Brute force: the DOUBLE casts keep the ANN pushdown out of the plan (no Score:), so every row is scored exactly.
SELECT id FROM {index.relation} ORDER BY emb::DOUBLE[{index.dims}] <#> $qd LIMIT $k;
