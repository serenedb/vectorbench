"""Pareto frontier and crossing, docs/contracts.md section 9.

The frontend implements the same algorithm; both are checked against
testdata/frontier_cases.json. Keep this file free of any other dependency so the rule stays
readable on its own.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

GAP_LIMIT = 0.02
EPS = 1e-9


@dataclass(frozen=True)
class Point:
    recall: float
    value: float
    knobs: dict[str, Any]
    index: int = -1  # position in the group's point list, for the detail view


def _is_number(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def usable_points(points: list[dict[str, Any]], metric: str) -> list[Point]:
    """Points with a numeric recall and a numeric, positive metric value."""
    out: list[Point] = []
    for i, p in enumerate(points):
        r = p.get("recall")
        v = _metric_value(p, metric)
        if _is_number(r) and _is_number(v) and v > 0:
            out.append(Point(float(r), float(v), dict(p.get("knobs") or {}), i))
    return out


def _metric_value(point: dict[str, Any], metric: str) -> Any:
    if metric == "qps":
        return point.get("qps")
    lat = point.get("latency_ms") or {}
    return lat.get(metric)


def frontier(points: list[Point], direction: str) -> list[Point]:
    """Pareto frontier: sorted by recall ascending, every point strictly better than all points
    with higher or equal recall."""
    better = (lambda a, b: a > b) if direction == "higher" else (lambda a, b: a < b)
    # recall descending; among equal recall the best value first
    ordered = sorted(points, key=lambda p: (-p.recall, -p.value if direction == "higher" else p.value))
    kept: list[Point] = []
    best: float | None = None
    for p in ordered:
        if best is None or better(p.value, best):
            kept.append(p)
            best = p.value
    kept.sort(key=lambda p: p.recall)
    return kept


def _adjacent_int(a: Point, b: Point) -> bool:
    if len(a.knobs) != 1 or len(b.knobs) != 1 or set(a.knobs) != set(b.knobs):
        return False
    (va,) = a.knobs.values()
    (vb,) = b.knobs.values()
    if isinstance(va, bool) or isinstance(vb, bool):
        return False
    if not (isinstance(va, int) or (isinstance(va, float) and va.is_integer())):
        return False
    if not (isinstance(vb, int) or (isinstance(vb, float) and vb.is_integer())):
        return False
    return abs(int(va) - int(vb)) == 1


def _bracket(points: list[Point], r: float) -> tuple[Point, Point]:
    a = max((p for p in points if p.recall <= r + EPS), key=lambda p: p.recall)
    b = min((p for p in points if p.recall >= r - EPS), key=lambda p: p.recall)
    return a, b


def crossing(points: list[Point], direction: str, r: float) -> dict[str, Any]:
    front = frontier(points, direction)
    if not front:
        return {"status": "none"}
    lo, hi = front[0], front[-1]
    if r > hi.recall + EPS:
        return {"status": "not_reached", "reached": hi.recall}
    if r <= lo.recall + EPS:
        return {"status": "above", "value": lo.value, "point": lo}
    # Density is a property of what the participant declared: the two measured points around r,
    # dominated or not, must be close. The value is then read off the frontier, so a dominated point
    # (slower and worse) never lowers the reading.
    da, db = _bracket(sorted(points, key=lambda p: p.recall), r)
    if not (da is db or abs(da.recall - db.recall) <= EPS):
        gap = db.recall - da.recall
        if gap > GAP_LIMIT + EPS and not _adjacent_int(da, db):
            return {"status": "bracket_too_wide", "gap": gap, "a": da, "b": db}
    a, b = _bracket(front, r)
    if a is b or abs(a.recall - b.recall) <= EPS:
        return {"status": "point", "value": a.value, "point": a}
    t = (r - a.recall) / (b.recall - a.recall)
    value = math.exp(math.log(a.value) + t * (math.log(b.value) - math.log(a.value)))
    return {"status": "interpolated", "value": value, "a": a, "b": b}


def cell(group: dict[str, Any] | None, metric: str, r: float | str) -> dict[str, Any]:
    """Cell value for a results-file group (contracts section 8) at the row's recall.

    `r` is a float or the string "exact"."""
    if group is None:
        return {"status": "unsupported"}
    status = group.get("status")
    if status != "ok":
        return {"status": status or "error", "reason": group.get("reason")}
    direction = "higher" if metric == "qps" else "lower"
    pts = usable_points(group.get("points") or [], metric)
    if r == "exact":
        if not pts:
            return {"status": "none"}
        p = pts[0]
        return {"status": "point", "value": p.value, "point": p}
    return crossing(pts, direction, float(r))
