import json
import math
from pathlib import Path

import pytest

from vectorbench.frontier import Point, crossing

CASES = json.loads(
    (Path(__file__).resolve().parents[1] / "lib/vectorbench/testdata/frontier_cases.json").read_text()
)["cases"]


def _points(raw):
    out = []
    for i, p in enumerate(raw):
        if p["recall"] is None:
            continue
        out.append(Point(p["recall"], p["value"], p["knobs"], i))
    return out


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_crossing_matches_shared_vectors(case):
    got = crossing(_points(case["points"]), case["direction"], case["r"])
    exp = case["expect"]
    assert got["status"] == exp["status"]
    if "value" in exp:
        assert math.isclose(got["value"], exp["value"], rel_tol=1e-6)
    if "reached" in exp:
        assert math.isclose(got["reached"], exp["reached"], rel_tol=1e-9)
    if "gap" in exp:
        assert math.isclose(got["gap"], exp["gap"], rel_tol=1e-6)
    if "a_recall" in exp:
        assert math.isclose(got["a"].recall, exp["a_recall"])
        assert math.isclose(got["b"].recall, exp["b_recall"])
