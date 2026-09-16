"""Dataset family definitions (docs/contracts.md section 1)."""

from __future__ import annotations

import re
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
DATASETS_DIR = REPO_ROOT / "datasets"

_SIZE_RE = re.compile(r"^(?P<family>.+)-(?P<size>[0-9]+[km])$")


@dataclass(frozen=True)
class QueryRow:
    id: str
    filter: str
    k: int
    recall: float | str  # float in (0, 1) or the string "exact"

    @property
    def exact(self) -> bool:
        return self.recall == "exact"

    @property
    def group_key(self) -> str:
        return group_key(self.filter, self.k, self.exact)

    @property
    def section(self) -> str:
        return "unfiltered" if self.filter == "none" else "filtered"


@dataclass(frozen=True)
class Group:
    key: str
    filter: str
    k: int
    exact: bool


def group_key(filter_case: str, k: int, exact: bool) -> str:
    return f"exact/{filter_case}/{k}" if exact else f"{filter_case}/{k}"


@dataclass
class Family:
    name: str
    title: str
    description: str
    dims: int
    metric: str
    source: dict[str, Any]
    sizes: dict[str, int]
    queries_count: int
    gt_depth: int
    shard_rows: int
    cluster_k: int
    cluster_train_rows: int
    filter_cases: dict[str, dict[str, Any]]
    queries: list[QueryRow]
    # size -> query id -> recall, overriding the row's own target for that dataset size.
    recall_by_size: dict[str, dict[str, float | str]] = field(default_factory=dict)
    path: Path | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    def dataset_id(self, size: str) -> str:
        if size not in self.sizes:
            raise KeyError(f"{self.name}: unknown size {size!r}; known: {', '.join(self.sizes)}")
        return f"{self.name}-{size}"

    def rows(self, size: str) -> int:
        return self.sizes[size]

    def queries_for(self, size: str) -> list[QueryRow]:
        """Rows with this size's recall targets applied.

        A target that is trivially met by the cheapest ladder point, or that no participant can
        reach, measures nothing; `recall_by_size` lets a family carry a different target per
        dataset size without duplicating the row list. See `vectorbench targets`.
        """
        over = self.recall_by_size.get(size) or {}
        if not over:
            return list(self.queries)
        return [replace(q, recall=over[q.id]) if q.id in over else q for q in self.queries]

    def groups(self) -> list[Group]:
        """Distinct groups in query-list order."""
        seen: dict[str, Group] = {}
        for q in self.queries:
            seen.setdefault(q.group_key, Group(q.group_key, q.filter, q.k, q.exact))
        return list(seen.values())

    def case(self, name: str) -> dict[str, Any]:
        if name not in self.filter_cases:
            raise KeyError(f"{self.name}: unknown filter case {name!r}")
        return self.filter_cases[name]

    def langs(self) -> list[str]:
        return list(self.source.get("langs") or [])

    def to_page_dict(self) -> dict[str, Any]:
        """The family block of frontend/results.json (contracts section 11)."""
        return {
            "family": self.name,
            "title": self.title,
            "description": self.description,
            "dims": self.dims,
            "metric": self.metric,
            "sizes": dict(self.sizes),
            "filter_cases": self.filter_cases,
            "queries": [
                {"id": q.id, "filter": q.filter, "k": q.k, "recall": q.recall} for q in self.queries
            ],
            "recall_by_size": {s: dict(o) for s, o in self.recall_by_size.items()},
        }


def _parse_recall(value: Any, qid: str) -> float | str:
    if value == "exact":
        return "exact"
    try:
        r = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"query {qid}: recall must be a number in (0, 1) or 'exact', got {value!r}")
    if not 0.0 < r < 1.0:
        raise ValueError(f"query {qid}: recall {r} is not in (0, 1)")
    return r


def load_family_file(path: Path) -> Family:
    raw = yaml.safe_load(path.read_text())
    queries = []
    ids: set[str] = set()
    for q in raw.get("queries") or []:
        qid = str(q["id"])
        if qid in ids:
            raise ValueError(f"{path}: duplicate query id {qid}")
        ids.add(qid)
        filt = str(q["filter"])
        if filt not in raw["filter_cases"]:
            raise ValueError(f"{path}: query {qid} uses unknown filter case {filt!r}")
        queries.append(QueryRow(qid, filt, int(q["k"]), _parse_recall(q["recall"], qid)))
    by_size: dict[str, dict[str, float | str]] = {}
    for size, over in (raw.get("recall_by_size") or {}).items():
        size = str(size)
        if size not in raw["sizes"]:
            raise ValueError(f"{path}: recall_by_size names unknown size {size!r}")
        out: dict[str, float | str] = {}
        for qid, value in (over or {}).items():
            qid = str(qid)
            if qid not in ids:
                raise ValueError(f"{path}: recall_by_size[{size}] names unknown query {qid!r}")
            out[qid] = _parse_recall(value, qid)
        by_size[size] = out
    known = {
        "family", "title", "description", "dims", "metric", "source", "sizes", "queries_count",
        "gt_depth", "shard_rows", "cluster_k", "cluster_train_rows", "filter_cases", "queries",
        "recall_by_size",
    }
    fam = Family(
        name=str(raw["family"]),
        title=str(raw.get("title") or raw["family"]),
        description=str(raw.get("description") or "").strip(),
        dims=int(raw["dims"]),
        metric=str(raw["metric"]),
        source=dict(raw["source"]),
        sizes={str(k): int(v) for k, v in raw["sizes"].items()},
        queries_count=int(raw.get("queries_count", 10000)),
        gt_depth=int(raw.get("gt_depth", 1000)),
        shard_rows=int(raw.get("shard_rows", 100000)),
        cluster_k=int(raw.get("cluster_k", 100)),
        cluster_train_rows=int(raw.get("cluster_train_rows", 1000000)),
        filter_cases={str(k): dict(v or {}) for k, v in raw["filter_cases"].items()},
        queries=queries,
        recall_by_size=by_size,
        path=path,
        extra={k: v for k, v in raw.items() if k not in known},
    )
    if fam.metric not in ("ip", "l2"):
        raise ValueError(f"{path}: metric must be ip or l2, got {fam.metric!r}")
    return fam


def load_family(name: str, datasets_dir: Path = DATASETS_DIR) -> Family:
    """Load by family name, by dataset id (`<family>-<size>`), or by yml path."""
    p = Path(name)
    if p.suffix == ".yml" and p.exists():
        return load_family_file(p)
    cand = datasets_dir / f"{name}.yml"
    if cand.exists():
        return load_family_file(cand)
    m = _SIZE_RE.match(name)
    if m:
        cand = datasets_dir / f"{m.group('family')}.yml"
        if cand.exists():
            return load_family_file(cand)
    raise FileNotFoundError(f"no family definition for {name!r} in {datasets_dir}")


def split_dataset_id(dataset: str) -> tuple[str, str]:
    """`wiki-v3-1024-100k` -> (`wiki-v3-1024`, `100k`)."""
    m = _SIZE_RE.match(dataset)
    if not m:
        raise ValueError(f"not a dataset id: {dataset!r} (expected <family>-<size>)")
    return m.group("family"), m.group("size")


def list_families(datasets_dir: Path = DATASETS_DIR) -> list[Family]:
    return [load_family_file(p) for p in sorted(datasets_dir.glob("*.yml"))]
