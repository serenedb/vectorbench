"""`vectorbench assemble`: every result file plus the family definitions -> frontend/results.json
(docs/contracts.md section 11)."""

from __future__ import annotations

import datetime as dt
import json
import logging
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
        out.append(obj)
    return out


def assemble(root: Path = REPO_ROOT, out_path: Path | None = None) -> Path:
    fams = {f.name: f.to_page_dict() for f in list_families(root / "datasets")}
    results = collect_results(root)
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
