import numpy as np
import pytest

from vectorbench import attributes as A
from vectorbench import groundtruth as G
from vectorbench import metrics as M


def _splitmix64_ref(x: int) -> int:
    m = (1 << 64) - 1
    z = (x + 0x9E3779B97F4A7C15) & m
    z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & m
    z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & m
    return z ^ (z >> 31)


def test_splitmix64_matches_scalar_reference():
    # first output of SplitMix64 seeded with 0 is the well-known 0xE220A8397B1DCDAF
    assert _splitmix64_ref(0) == 0xE220A8397B1DCDAF
    xs = np.array([0, 1, 2, 12345, 2**63, 2**64 - 1], dtype=np.uint64)
    out = A.splitmix64(xs)
    for x, o in zip(xs.tolist(), out.tolist()):
        assert o == _splitmix64_ref(x)
    # and h() composes as documented
    seed = 7
    mix = (seed * 0x9E3779B97F4A7C15) & ((1 << 64) - 1)
    assert int(A.h(np.array([42], dtype=np.uint64), seed)[0]) == _splitmix64_ref(_splitmix64_ref(42) ^ mix)


def test_synthetic_columns_deterministic_and_prefix_stable():
    ids = np.arange(1000)
    a = A.synthetic_columns(ids)
    b = A.synthetic_columns(np.arange(5000))
    for col in ("cat10", "cat100", "cat1000", "num"):
        assert np.array_equal(a[col], b[col][:1000])
    assert a["cat10"].min() >= 0 and a["cat10"].max() <= 9
    assert a["cat1000"].max() <= 999
    assert a["num"].max() < A.NUM_RANGE
    assert str(a["ts"][0]) == "2020-01-01T00:00:00"
    assert str(a["ts"][61]) == "2020-01-01T00:01:01"


def test_synthetic_columns_roughly_uniform():
    ids = np.arange(200_000)
    c = A.synthetic_columns(ids)
    counts = np.bincount(c["cat10"].astype(np.int64), minlength=10)
    assert abs(counts - 20_000).max() < 800  # about 5 sigma
    counts = np.bincount(c["cat100"].astype(np.int64), minlength=100)
    assert abs(counts - 2_000).max() < 250


def _qinfo(nq, langs=("en", "de")):
    return {
        "query_cluster": np.arange(nq) % 7,
        "far_cluster": (np.arange(nq) + 3) % 7,
        "query_lang": np.array([langs[i % len(langs)] for i in range(nq)], dtype=object),
        "langs": list(langs),
    }


def test_query_args_and_predicates_agree():
    nq, rows = 50, 20_000
    ids = np.arange(rows)
    cols = A.synthetic_columns(ids)
    cols["cluster"] = (ids % 7).astype(np.int16)
    cols["lang"] = np.array(["en" if i % 2 else "de" for i in range(rows)], dtype=object)
    qids = np.arange(nq)
    qi = _qinfo(nq)
    cases = {
        "eq-10": {"op": "eq", "field": "cat10"},
        "eq-1": {"op": "eq", "field": "cat100"},
        "range-10": {"op": "range", "field": "num", "fraction": 0.10},
        "and-1": {"op": "and", "terms": [{"op": "eq", "field": "cat10"}, {"op": "range", "field": "num", "fraction": 0.10}]},
        "corr": {"op": "eq", "field": "cluster", "value": "query_cluster"},
        "xcorr": {"op": "eq", "field": "cluster", "value": "far_cluster"},
        "lang": {"op": "eq", "field": "lang", "value": "query_lang"},
        "xlang": {"op": "eq", "field": "lang", "value": "other_lang"},
    }
    expected_sel = {"eq-10": 0.10, "eq-1": 0.01, "range-10": 0.10, "and-1": 0.01, "corr": 1 / 7, "xcorr": 1 / 7, "lang": 0.5, "xlang": 0.5}
    for name, spec in cases.items():
        args = A.query_args(name, spec, qids, qi)
        mask = A.predicate_mask(spec, cols, args)
        assert mask.shape == (nq, rows)
        sel = mask.mean()
        assert abs(sel - expected_sel[name]) < 0.02, (name, sel)
        # scalar check agrees with the vectorized mask on a few rows
        for q in (0, 7):
            qa = A.args_for_query(args, q, spec)
            assert set(qa) == set(A.used_arg_keys(spec))
            for r in (0, 1, 2, 12345):
                row = {c: cols[c][r] for c in cols}
                assert A.row_satisfies(spec, row, qa) == bool(mask[q, r])
    xl = A.query_args("xlang", cases["xlang"], qids, qi)["s"]
    assert list(xl[:2]) == ["de", "en"]  # other_lang rotates within the family's langs


def test_range_width_is_exact():
    spec = {"op": "range", "field": "num", "fraction": 0.01}
    args = A.query_args("range-1", spec, np.arange(10), _qinfo(10))
    assert np.all(args["hi"] - args["lo"] + 1 == 10_000)
    assert args["hi"].max() < A.NUM_RANGE


def test_stats_shape():
    s = M.stats([1.0, 2.0, 3.0, 4.0])
    assert s["n"] == 4 and s["min"] == 1.0 and s["max"] == 4.0 and s["avg"] == 2.5 and s["p50"] == 2.5
    assert M.stats([])["n"] == 0


def test_recall_tie_aware_and_strict():
    gt_ids = np.array([[5, 7, 9, 11, 13]], dtype=np.int32)
    gt_d = np.array([[0.1, 0.2, 0.3, 0.3, 0.9]], dtype=np.float32)
    # k=3: strict top-3 = {5,7,9}; tie set includes 11 (distance equal to the 3rd)
    ret = M.pad_ids([[5, 7, 11]], 3)
    r = M.recall(ret, gt_ids, gt_d, 3)
    assert r["recall_strict"] == pytest.approx(2 / 3)
    assert r["recall"] == pytest.approx(1.0)
    assert r["tail"] == 0.0
    # short result and padding
    ret = M.pad_ids([[5]], 3)
    r = M.recall(ret, gt_ids, gt_d, 3)
    assert r["recall"] == pytest.approx(1 / 3)
    assert r["tail"] == 1.0
    # invalid ground truth slots never count
    gt_ids2 = np.array([[5, -1, -1]], dtype=np.int32)
    gt_d2 = np.array([[0.1, np.inf, np.inf]], dtype=np.float32)
    r = M.recall(M.pad_ids([[5, 6, 7]], 3), gt_ids2, gt_d2, 3)
    assert r["recall"] == pytest.approx(1 / 3)


@pytest.mark.parametrize("metric", ["l2", "ip"])
def test_groundtruth_matches_naive(metric):
    rng = np.random.default_rng(1)
    base = rng.standard_normal((5000, 16)).astype(np.float32)
    queries = rng.standard_normal((37, 16)).astype(np.float32)
    ids = np.arange(5000)
    cols = A.synthetic_columns(ids)
    spec = {"op": "eq", "field": "cat10"}
    args = A.query_args("eq-10", spec, np.arange(37), _qinfo(37))
    cases = {
        "none": G.none_mask(),
        "eq-10": lambda c, qsel: A.predicate_mask(spec, c, args, qsel),
    }

    def blocks():
        for s in range(0, 5000, 1234):
            e = min(s + 1234, 5000)
            yield ids[s:e], base[s:e], {k: v[s:e] for k, v in cols.items()}

    res = G.compute(queries, blocks(), metric, depth=50, cases=cases, query_batch=10)
    exp_ids, exp_d = G.naive_topk(queries, base, metric, 50)
    assert np.allclose(res["none"]["dists"], exp_d, rtol=1e-4, atol=1e-4)
    assert np.array_equal(res["none"]["ids"], exp_ids)
    assert np.all(res["none"]["matches"] == 5000)
    mask = A.predicate_mask(spec, cols, args)
    exp_ids, exp_d = G.naive_topk(queries, base, metric, 50, mask)
    assert np.allclose(res["eq-10"]["dists"], exp_d, rtol=1e-4, atol=1e-4)
    assert np.array_equal(res["eq-10"]["ids"], exp_ids)
    assert np.array_equal(res["eq-10"]["matches"], mask.sum(axis=1))


@pytest.mark.parametrize("metric", ["l2", "ip"])
@pytest.mark.parametrize("block_rows,depth", [(30, 100), (100, 100), (137, 100)])
def test_groundtruth_blocks_narrower_than_depth(metric, block_rows, depth):
    """A block reduced to its own top-`depth` has a second path for blocks no wider than depth, and
    the boundary where the two meet is where an off-by-one would hide."""
    rng = np.random.default_rng(7)
    n = 900
    base = rng.standard_normal((n, 8)).astype(np.float32)
    queries = rng.standard_normal((11, 8)).astype(np.float32)
    ids = np.arange(n)

    def blocks():
        for s in range(0, n, block_rows):
            e = min(s + block_rows, n)
            yield ids[s:e], base[s:e], {}

    res = G.compute(queries, blocks(), metric, depth=depth,
                    cases={"none": G.none_mask()}, query_batch=4)
    exp_ids, exp_d = G.naive_topk(queries, base, metric, depth)
    assert np.allclose(res["none"]["dists"], exp_d, rtol=1e-4, atol=1e-4)
    assert np.array_equal(res["none"]["ids"], exp_ids)
