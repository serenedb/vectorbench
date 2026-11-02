"""`prepare` from a local copy of an hf corpus: the parallel one-pass path writes exactly what the
serial path writes, and both follow the interleaved stream the source defines."""

import json
import zlib

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
import yaml

from vectorbench.families import load_family_file
from vectorbench.prepare import Preparer

DIMS = 8
FILES = {"en": [23, 17, 11], "de": [9, 13], "xx": [7], "yy": [30]}
QUERY_LANGS = ["en", "de"]
INTERLEAVE = 4


def _vec(lang: str, f: int, r: int) -> np.ndarray:
    rng = np.random.default_rng(zlib.crc32(f"{lang}-{f}-{r}".encode()))
    v = rng.standard_normal(DIMS).astype(np.float32)
    return v / np.linalg.norm(v)


@pytest.fixture()
def corpus(tmp_path):
    root = tmp_path / "corpus"
    for lang, sizes in FILES.items():
        (root / lang).mkdir(parents=True)
        for f, n in enumerate(sizes):
            emb = [list(map(float, _vec(lang, f, r))) for r in range(n)]
            t = pa.table({"title": [f"{lang}-{f}-{r}" for r in range(n)], "emb": pa.array(emb, type=pa.list_(pa.float32()))})
            pq.write_table(t, root / lang / f"{f:04d}.parquet", row_group_size=5)
    return root


@pytest.fixture()
def family(tmp_path):
    spec = {
        "family": "toy",
        "dims": DIMS,
        "metric": "ip",
        "source": {"kind": "hf", "repo": "x/toy", "langs": QUERY_LANGS, "base_langs": "all", "columns": {"emb": "emb", "title": "title"}, "interleave_rows": INTERLEAVE},
        "sizes": {"60k": 60},
        "queries_count": 6,
        "gt_depth": 5,
        "shard_rows": 25,
        "cluster_k": 3,
        "cluster_train_rows": 40,
        "filter_cases": {
            "none": {},
            "eq-10": {"op": "eq", "field": "cat10"},
            "range-10": {"op": "range", "field": "num", "fraction": 0.1},
            "and-1": {"op": "and", "terms": [{"op": "eq", "field": "cat10"}, {"op": "range", "field": "num", "fraction": 0.1}]},
            "corr": {"op": "eq", "field": "cluster", "value": "query_cluster"},
            "xcorr": {"op": "eq", "field": "cluster", "value": "far_cluster"},
            "lang": {"op": "eq", "field": "lang", "value": "query_lang"},
            "xlang": {"op": "eq", "field": "lang", "value": "other_lang"},
        },
        "queries": [{"id": "V01", "filter": "none", "k": 5, "recall": 0.9}],
    }
    p = tmp_path / "toy.yml"
    p.write_text(yaml.safe_dump(spec))
    return load_family_file(p)


def _expected_stream(rows: int) -> list[tuple[str, int, int]]:
    """Round-robin chunks over the query languages, then the rest by name; query languages hold out
    their last file."""
    order = QUERY_LANGS + sorted(set(FILES) - set(QUERY_LANGS))
    per_lang = {l: [(l, f, r) for f, n in enumerate(FILES[l][:-1] if l in QUERY_LANGS else FILES[l]) for r in range(n)] for l in order}
    out: list[tuple[str, int, int]] = []
    while len(out) < rows:
        for l in order:
            take = per_lang[l][:INTERLEAVE][: rows - len(out)]
            per_lang[l] = per_lang[l][len(take):]
            out.extend(take)
    return out


def _prepare(family, corpus, root, workers):
    return Preparer(family, "60k", root, workers=workers, source_dir=corpus).run()


def test_parallel_matches_serial_and_the_stream(family, corpus, tmp_path):
    a = _prepare(family, corpus, tmp_path / "a", 1)
    b = _prepare(family, corpus, tmp_path / "b", 2)
    assert a["rows"] == b["rows"] == 60
    assert [s["sha256"] for s in a["shards"]] == [s["sha256"] for s in b["shards"]]
    assert [s["rows"] for s in b["shards"]] == [25, 25, 10]
    da, db = tmp_path / "a" / "toy-60k", tmp_path / "b" / "toy-60k"
    assert np.array_equal(np.load(da / "centroids.npy"), np.load(db / "centroids.npy"))
    assert pq.read_table(da / "queries.parquet").equals(pq.read_table(db / "queries.parquet"))
    for case in family.filter_cases:
        za, zb = np.load(da / "gt" / f"{case}.npz"), np.load(db / "gt" / f"{case}.npz")
        assert np.array_equal(za["dists"], zb["dists"]), case
        assert np.array_equal(za["matches"], zb["matches"]), case
        assert np.array_equal(za["ids"], zb["ids"]), case

    base = pq.read_table([db / s["path"] for s in b["shards"]][0])
    for s in b["shards"][1:]:
        base = pa.concat_tables([base, pq.read_table(db / s["path"])])
    expected = _expected_stream(60)
    assert base.column("id").to_pylist() == list(range(60))
    assert base.column("lang").to_pylist() == [l for l, _, _ in expected]
    assert base.column("title").to_pylist() == [f"{l}-{f}-{r}" for l, f, r in expected]
    emb = np.asarray(base.column("emb").combine_chunks().flatten()).reshape(60, DIMS)
    assert np.array_equal(emb, np.stack([_vec(l, f, r) for l, f, r in expected]))

    q = pq.read_table(db / "queries.parquet")
    assert q.column("lang").to_pylist() == ["en"] * 3 + ["de"] * 3
    manifest = json.loads((db / "manifest.json").read_text())
    assert manifest["nq"] == 6 and manifest["gt_depth"] == 5


def test_queries_override(family, corpus, tmp_path):
    m = Preparer(family, "60k", tmp_path / "c", workers=2, source_dir=corpus, queries=4).run()
    assert m["nq"] == 4
    assert np.load(tmp_path / "c" / "toy-60k" / "gt" / "none.npz")["ids"].shape == (4, 5)
