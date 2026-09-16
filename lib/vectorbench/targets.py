"""Choose a recall target per (dataset, size) from what the participants actually measured.

A target only decides how the frontier is read, never what is measured, so it can be chosen after
the fact. It is a bad target when no participant's ladder crosses it: either everyone saturates
below it (the cheapest declared point already beats it, so the row reports the cheapest point and
says nothing about recall), or nobody reaches it, or the two measured points around it are too far
apart for the crossing rule to interpolate. This module reports which of those happened per group
and proposes the `recall_by_size` block for the family file.

`vectorbench targets --dataset wiki-v3-1024-1m`
"""

from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .families import Family, load_family, split_dataset_id
from .frontier import cell

REPO_ROOT = Path(__file__).resolve().parents[2]

# Targets worth publishing: round enough to read, dense enough near 1 to separate good engines.
CANDIDATES: tuple[float, ...] = (
    0.80, 0.85, 0.90, 0.92, 0.95, 0.96, 0.97, 0.98, 0.99, 0.995, 0.997, 0.999,
)
# A crossing the frontier resolves by interpolating between two measured points.
CROSSED = ("point", "interpolated")
# Readable cells: `above` means the participant's cheapest declared point already beats the target,
# so the cell is its speed at a recall the target is satisfied by. That is a fair speed comparison,
# just not a recall comparison.
READABLE = CROSSED + ("above",)


@dataclass(frozen=True)
class GroupReading:
    """How every participant answers one (group, view) at one candidate target."""

    target: float
    statuses: dict[str, str]  # participant id -> crossing status

    @property
    def readable(self) -> int:
        return sum(1 for s in self.statuses.values() if s in READABLE)

    @property
    def crossed(self) -> int:
        return sum(1 for s in self.statuses.values() if s in CROSSED)

    @property
    def degenerate(self) -> int:
        return sum(1 for s in self.statuses.values() if s == "n/a")

    @property
    def saturated(self) -> int:
        return sum(1 for s in self.statuses.values() if s == "above")

    @property
    def missed(self) -> int:
        return sum(1 for s in self.statuses.values() if s == "not_reached")

    @property
    def sparse(self) -> int:
        return sum(1 for s in self.statuses.values() if s == "bracket_too_wide")


def load_dataset_results(dataset: str, root: Path = REPO_ROOT) -> dict[str, dict[str, Any]]:
    """Participant id -> result file, for every participant that ran this dataset."""
    out: dict[str, dict[str, Any]] = {}
    for p in sorted(root.glob("*/results/*.json")):
        try:
            doc = json.loads(p.read_text())
        except (OSError, ValueError):
            continue
        if doc.get("dataset") != dataset:
            continue
        pid = str(doc.get("participant") or p.parent.parent.name)
        out[pid] = doc
    return out


def _groups_by_key(doc: dict[str, Any]) -> dict[tuple[str, str], dict[str, Any]]:
    out: dict[tuple[str, str], dict[str, Any]] = {}
    for g in doc.get("groups") or []:
        out[(str(g.get("key")), str(g.get("view")))] = g
    return out


def read_group(
    docs: dict[str, dict[str, Any]], key: str, view: str, metric: str, target: float
) -> GroupReading:
    statuses: dict[str, str] = {}
    for pid, doc in docs.items():
        g = _groups_by_key(doc).get((key, view))
        statuses[pid] = str(cell(g, metric, target).get("status"))
    return GroupReading(target, statuses)


def _score(reading: GroupReading) -> tuple[int, int, int, int, float]:
    """Best first: most participants able to answer at all, then most that genuinely cross the
    target, then fewest that fall short of it, then fewest whose ladder is too coarse there.

    Readability comes first because an unanswerable cell counts against a participant exactly like
    a slow one. Among equally readable targets the one more participants cross is the more
    informative: it separates engines on recall as well as on speed. The last key breaks remaining
    ties towards the higher target, so a row every participant clears is published at the strongest
    bar they all clear rather than at the lowest candidate.
    """
    return (reading.readable, reading.crossed, -reading.missed, -reading.sparse, reading.target)


def propose(
    family: Family, size: str, root: Path = REPO_ROOT, metric: str = "qps", view: str = "throughput"
) -> dict[str, Any]:
    dataset = family.dataset_id(size)
    docs = load_dataset_results(dataset, root)
    rows = family.queries_for(size)
    out: dict[str, Any] = {
        "dataset": dataset, "participants": sorted(docs), "rows": [], "changed": {}, "skip": [],
    }
    if not docs:
        return out
    # One reading per (group, candidate) is reused by every row on that group.
    cache: dict[tuple[str, float], GroupReading] = {}

    def reading(key: str, t: float) -> GroupReading:
        hit = cache.get((key, t))
        if hit is None:
            hit = read_group(docs, key, view, metric, t)
            cache[(key, t)] = hit
        return hit

    # Rows on one group exist to sample its frontier at several bars, so they are assigned
    # together: the n best-scoring distinct candidates, in the same order as the targets they
    # replace. Assigning each row independently would collapse them onto one value.
    by_group: dict[str, list[Any]] = defaultdict(list)
    for q in rows:
        if not q.exact:
            by_group[q.group_key].append(q)

    for key, qs in by_group.items():
        qs = sorted(qs, key=lambda q: float(q.recall))
        ranked = sorted(
            (reading(key, t) for t in CANDIDATES), key=_score, reverse=True
        )
        best = ranked[0]
        chosen = sorted(r.target for r in ranked[: len(qs)])
        for q, target in zip(qs, chosen):
            now = reading(key, float(q.recall))
            picked = reading(key, target)
            verdict = "ok" if _score(now) >= _score(picked) else "replace"
            if best.degenerate == len(best.statuses):
                # The match set is too small for this k: both sides decline, by design, at this size.
                verdict, target, picked = "degenerate", float(q.recall), now
            elif best.readable == 0:
                verdict, target, picked = "no_target", float(q.recall), now
            elif picked.crossed == 0 and verdict == "ok":
                # Everyone is above: the row still compares speed, at a bar all of them clear.
                verdict = "saturated"
            out["rows"].append({
                "id": q.id,
                "group": key,
                "current": float(q.recall),
                "current_status": dict(now.statuses),
                "proposed": target,
                "proposed_status": dict(picked.statuses),
                "verdict": verdict,
                "advice": _advice(best, [reading(key, t) for t in CANDIDATES]),
            })
            if verdict == "replace":
                out["changed"][q.id] = target
            elif verdict == "degenerate":
                out["skip"].append(q.id)
    out["rows"].sort(key=lambda r: r["id"])
    return out


def _advice(best: GroupReading, all_readings: list[GroupReading]) -> str:
    """What to change when no candidate resolves: the ladder, not the target."""
    if best.degenerate == len(best.statuses):
        return "match set too small for this k at this size: drop the row here"
    if best.crossed == 0 and best.readable:
        return "every participant clears the highest candidate: speed-only row, or add cheaper ladder points"
    if best.readable:
        return ""
    if any(r.sparse for r in all_readings):
        return "the two points around the target are too far apart: add ladder points between them"
    if all(r.missed for r in all_readings if r.target >= 0.99):
        return "no participant reaches the high targets: extend the ladder upwards"
    return "ladder cannot resolve any candidate target"


def render(result: dict[str, Any]) -> str:
    lines: list[str] = []
    parts = result["participants"]
    if not parts:
        return f"{result['dataset']}: no result files\n"
    lines.append(f"{result['dataset']}  participants: {', '.join(parts)}")
    lines.append(f"{'row':5} {'group':16} {'now':>6} {'proposed':>8} {'verdict':9} statuses")
    for r in result["rows"]:
        st = " ".join(f"{p.split('-')[0][:4]}={r['proposed_status'][p][:4]}" for p in parts)
        lines.append(
            f"{r['id']:5} {r['group']:16} {r['current']:6.3f} {r['proposed']:8.3f} "
            f"{r['verdict']:9} {st}"
        )
        if r["advice"]:
            lines.append(f"{'':41}  ! {r['advice']}")
    size = result["dataset"].rsplit("-", 1)[1]
    if result["changed"]:
        lines.append("")
        lines.append("recall_by_size:")
        lines.append(f"  {size}:")
        for qid, t in sorted(result["changed"].items()):
            lines.append(f"    {qid}: {t}")
    if result["skip"]:
        lines.append("")
        lines.append("skip_by_size:")
        lines.append(f"  {size}: [{', '.join(sorted(result['skip']))}]")
    return "\n".join(lines) + "\n"


def run(dataset: str, root: Path = REPO_ROOT, view: str = "throughput", metric: str = "qps") -> str:
    fam_name, size = split_dataset_id(dataset)
    family = load_family(fam_name)
    return render(propose(family, size, root, metric=metric, view=view))
