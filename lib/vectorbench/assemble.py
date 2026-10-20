"""`vectorbench assemble`: every result file plus the family definitions -> frontend/results.json
(docs/contracts.md section 11). `--dataset` narrows the page to chosen datasets without touching
the result files of the others."""

from __future__ import annotations

import datetime as dt
import json
import logging
from collections.abc import Iterable
from pathlib import Path
from typing import Any

from .families import REPO_ROOT, list_families, split_dataset_id
from .results import write_json_atomic

log = logging.getLogger(__name__)


def collect_results(root: Path = REPO_ROOT) -> list[dict[str, Any]]:
    out = []
    for p in sorted(root.glob("*/results/*.json")):
        if p.name.endswith(".partial.json") or p.parent.name == "load":
            continue
        try:
            obj = json.loads(p.read_text())
        except json.JSONDecodeError as e:
            log.warning("skipping %s: %s", p, e)
            continue
        if not isinstance(obj, dict) or "dataset" not in obj or "groups" not in obj:
            log.warning("skipping %s: not a result file", p)
            continue
        obj["_source"] = str(p.relative_to(root))
        obj["_mtime"] = p.stat().st_mtime
        out.append(obj)
    newest: dict[tuple[str, str], dict[str, Any]] = {}
    for obj in out:
        key = (obj.get("participant") or "", obj["dataset"])
        prev = newest.get(key)
        if prev is None or obj["_mtime"] > prev["_mtime"]:
            newest[key] = obj
    for obj in out:
        key = (obj.get("participant") or "", obj["dataset"])
        if newest[key] is not obj:
            log.info("superseded: %s (label %s)", obj["_source"], obj.get("label"))
    kept = list(newest.values())
    for obj in kept:
        obj.pop("_mtime", None)
    return sorted(kept, key=lambda o: (o.get("participant") or "", o["dataset"]))


def only_datasets(
    fams: dict[str, dict[str, Any]], results: list[dict[str, Any]], datasets: Iterable[str]
) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    """The result files of `datasets` (`<family>-<size>`) and the families they belong to.

    The page then shows those datasets and nothing older, while every other result file stays in
    the repository for an assembly that wants it. A dataset with no result file is an error, not
    an empty page: it is almost always a typo."""
    wanted = set(datasets)
    kept = [r for r in results if r["dataset"] in wanted]
    missing = wanted - {r["dataset"] for r in kept}
    if missing:
        raise ValueError(f"no result files for {', '.join(sorted(missing))}")
    used = {split_dataset_id(d)[0] for d in wanted}
    return {name: f for name, f in fams.items() if name in used}, kept


def assemble(root: Path = REPO_ROOT, out_path: Path | None = None, datasets: Iterable[str] = ()) -> Path:
    fams = {f.name: f.to_page_dict() for f in list_families(root / "datasets")}
    results = collect_results(root)
    datasets = list(datasets)
    if datasets:
        fams, results = only_datasets(fams, results, datasets)
    for r in results:
        fam, _ = split_dataset_id(r["dataset"])
        if fam not in fams:
            log.warning("%s: dataset %s has no family definition", r["_source"], r["dataset"])
    page = {
        "generated": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
        "families": fams,
        "results": results,
    }
    out_path = out_path or (root / "frontend" / "results.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    write_json_atomic(out_path, page)
    log.info("wrote %s: %d families, %d result files", out_path, len(fams), len(results))
    return out_path
