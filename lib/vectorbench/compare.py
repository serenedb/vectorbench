"""Head-to-head between two participants on one dataset, row by row.

Reads each row at the bar its dataset declares (contracts sections 9 and 13) and reports who is
ahead, on both views. A row neither side can answer is not a comparison and is listed separately,
because an unanswerable cell is a coverage failure rather than a result.

`vectorbench compare --dataset sift-128-1m --us serenedb-hnsw --them qdrant-hnsw`
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .families import load_family, split_dataset_id
from .frontier import cell
from .targets import _groups_by_key, load_dataset_results

REPO_ROOT = Path(__file__).resolve().parents[2]

# Views and metrics the summary covers: loaded throughput, then single-client latency.
VIEWS: tuple[tuple[str, str, str], ...] = (
    ("throughput", "qps", "higher"),
    ("latency", "p50", "lower"),
    ("latency", "p99", "lower"),
)
# Inside this band the two are called even: below it the measurement noise of a six-second pass is
# larger than the difference.
TIE_BAND = 0.02


@dataclass
class Row:
    id: str
    group: str
    bar: float | str
    view: str
    metric: str
    ours: float | None
    theirs: float | None
    our_status: str
    their_status: str

    @property
    def ratio(self) -> float | None:
        """Above one means we are ahead, whichever direction the metric runs."""
        if self.ours is None or self.theirs is None or self.ours <= 0 or self.theirs <= 0:
            return None
        higher = self.metric == "qps"
        return self.ours / self.theirs if higher else self.theirs / self.ours

    @property
    def verdict(self) -> str:
        r = self.ratio
        if r is None:
            # Both declining the same group is the shape being out of scope at this size, not a loss.
            if self.our_status == self.their_status == "n/a":
                return "n/a"
            return "unreadable"
        if r > 1 + TIE_BAND:
            return "win"
        if r < 1 - TIE_BAND:
            return "loss"
        return "tie"


# What "the same index" means across engines: the graph shape, and how many bits a stored vector
# keeps. The names differ per engine, so each is mapped to these three.
@dataclass(frozen=True)
class Build:
    m: int | None
    ef_construction: int | None
    bits: int | None  # bits per dimension of the stored codes; 32 means no quantization

    def differs_from(self, other: "Build") -> list[str]:
        out = []
        for name in ("m", "ef_construction", "bits"):
            a, b = getattr(self, name), getattr(other, name)
            if a is not None and b is not None and a != b:
                out.append(f"{name} {a} vs {b}")
            elif (a is None) != (b is None):
                out.append(f"{name} {a if a is not None else 'unknown'} vs "
                           f"{b if b is not None else 'unknown'}")
        return out


# quantization name -> bits per dimension. Anything absent is read as full precision.
_BITS = {
    "none": 32, "1x": 32, "fp32": 32,
    "fp16": 16, "2x": 16, "sq16": 16,
    "sq8": 8, "int8": 8, "int8_hnsw": 8, "byte": 8, "4x": 8, "scalar": 8,
    "sq4": 4, "int4_hnsw": 4, "8x": 4,
    "16x": 2, "tq": 2,
    "binary": 1, "bbq": 1, "bbq_hnsw": 1, "32x": 1,
}


def read_build(doc: dict[str, Any]) -> Build:
    """The build a result file records, however its loader spelled it."""
    info = (doc.get("disk_info") or {})
    idx = info.get("index")
    if not isinstance(idx, dict):
        idx = (doc.get("index") or {}).get("params") or {}
    def num(*names):
        for n in names:
            v = idx.get(n)
            if isinstance(v, (int, float)):
                return int(v)
        return None
    quant = None
    for n in ("quant", "type", "compression_level", "quantization"):
        v = idx.get(n)
        if isinstance(v, str):
            quant = v.lower()
            break
    return Build(num("m"), num("ef_construction", "ef_construct"), _BITS.get(quant or ""))


@dataclass
class Summary:
    dataset: str
    us: str
    them: str
    builds: dict[str, Build] = field(default_factory=dict)
    partial: dict[str, bool] = field(default_factory=dict)
    build_mismatch: list[str] = field(default_factory=list)
    rows: list[Row] = field(default_factory=list)

    def counts(self, view: str, metric: str) -> dict[str, int]:
        out = {"win": 0, "tie": 0, "loss": 0, "unreadable": 0, "n/a": 0}
        for r in self.rows:
            if r.view == view and r.metric == metric:
                out[r.verdict] += 1
        return out


def compare(dataset: str, us: str, them: str, root: Path = REPO_ROOT,
            section: str | None = None) -> Summary:
    fam_name, size = split_dataset_id(dataset)
    fam = load_family(fam_name)
    docs = load_dataset_results(dataset, root)
    for who in (us, them):
        if who not in docs:
            raise SystemExit(f"no {dataset} results for {who}; have: {', '.join(sorted(docs)) or 'none'}")
    idx = {p: _groups_by_key(d) for p, d in docs.items()}
    out = Summary(dataset, us, them)
    out.builds = {p: read_build(docs[p]) for p in (us, them)}
    out.partial = {p: bool(docs[p].get("__partial__")) for p in (us, them)}
    out.build_mismatch = out.builds[us].differs_from(out.builds[them])
    for q in fam.queries_for(size):
        if section == "unfiltered" and q.filter != "none":
            continue
        if section == "filtered" and q.filter == "none":
            continue
        for view, metric, _ in VIEWS:
            a = cell(idx[us].get((q.group_key, view)), metric, q.recall)
            b = cell(idx[them].get((q.group_key, view)), metric, q.recall)
            out.rows.append(Row(
                id=q.id, group=q.group_key, bar=q.recall, view=view, metric=metric,
                ours=a.get("value"), theirs=b.get("value"),
                our_status=str(a.get("status")), their_status=str(b.get("status")),
            ))
    return out


def render(s: Summary, verbose: bool = False) -> str:
    marks = {who: " (RUN IN PROGRESS)" if s.partial.get(who) else "" for who in (s.us, s.them)}
    lines = [f"{s.dataset}: {s.us}{marks[s.us]} vs {s.them}{marks[s.them]}   "
             f"(ratio above 1 means {s.us} is ahead)"]
    if s.build_mismatch:
        lines.append("  !! BUILD MISMATCH: " + "; ".join(s.build_mismatch) +
                     " -- the numbers below compare two different indexes")
    lines += [
             f"{'view/metric':18} {'win':>4} {'tie':>4} {'loss':>5} {'unreadable':>11} {'n/a':>5}"]
    for view, metric, _ in VIEWS:
        c = s.counts(view, metric)
        lines.append(f"{view + '/' + metric:18} {c['win']:4d} {c['tie']:4d} {c['loss']:5d} "
                     f"{c['unreadable']:11d} {c['n/a']:5d}")
    shown = [r for r in s.rows if r.verdict in (("loss", "unreadable") if not verbose else
                                                ("win", "tie", "loss", "unreadable"))]
    if shown:
        lines.append("")
        lines.append(f"{'':11}{'row':5} {'group':16} {'bar':>6} {'view/metric':17} "
                     f"{'ours':>10} {'theirs':>10} {'ratio':>6}")
    for r in shown:
        ratio = f"{r.ratio:6.2f}" if r.ratio is not None else "     -"
        ours = f"{r.ours:10.1f}" if r.ours is not None else f"{r.our_status:>10}"
        theirs = f"{r.theirs:10.1f}" if r.theirs is not None else f"{r.their_status:>10}"
        lines.append(f"{r.verdict.upper():11}{r.id:5} {r.group:16} {str(r.bar):>6} "
                     f"{r.view + '/' + r.metric:17} {ours} {theirs} {ratio}")
    return "\n".join(lines) + "\n"


def run(dataset: str, us: str, them: str, root: Path = REPO_ROOT,
        section: str | None = None, verbose: bool = False) -> str:
    return render(compare(dataset, us, them, root, section), verbose)
