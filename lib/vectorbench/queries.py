"""Query files, settings resolution and ladders (docs/contracts.md sections 5 and 6)."""

from __future__ import annotations

import itertools
import json
import re
from pathlib import Path
from typing import Any

from .families import Family, Group

HEADER_RE = re.compile(r"^\s*--\s*group:\s*(?P<key>\S+)\s*$", re.M)
KNOB_RE = re.compile(r"\{([A-Za-z_][A-Za-z0-9_]*)\}")
INDEX_RE = re.compile(r"\{index\.([A-Za-z_][A-Za-z0-9_]*)\}")


def load_blocks(path: Path) -> dict[str, str]:
    """group key -> block text. `.sql`: header comments `-- group: key`; `.json`: top-level object."""
    text = path.read_text()
    if path.suffix == ".json":
        obj = json.loads(text)
        if not isinstance(obj, dict):
            raise ValueError(f"{path}: top level must be an object of group key -> block")
        return {str(k): json.dumps(v) for k, v in obj.items()}
    blocks: dict[str, str] = {}
    matches = list(HEADER_RE.finditer(text))
    for i, m in enumerate(matches):
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[m.end() : end].strip()
        # drop comment-only lines so a trailing comment does not become a statement
        body = "\n".join(line for line in body.splitlines() if not line.strip().startswith("--")).strip()
        if not body:
            raise ValueError(f"{path}: group {m.group('key')} has no statements")
        if m.group("key") in blocks:
            raise ValueError(f"{path}: duplicate group {m.group('key')}")
        blocks[m.group("key")] = body
    return blocks


def resolve_block(blocks: dict[str, str], group: Group) -> str | None:
    prefix = "exact/" if group.exact else ""
    for key in (f"{prefix}{group.filter}/{group.k}", f"{prefix}{group.filter}/*"):
        if key in blocks:
            return blocks[key]
    return None


def substitute_knobs(block: str, knobs: dict[str, Any]) -> str:
    def repl(m: re.Match[str]) -> str:
        name = m.group(1)
        if name not in knobs:
            raise KeyError(f"block uses knob {{{name}}} but the ladder does not define it")
        v = knobs[name]
        return json.dumps(v) if isinstance(v, bool) else str(v)

    return KNOB_RE.sub(repl, block)


def knob_names(block: str) -> set[str]:
    return set(KNOB_RE.findall(block))


def substitute_index(block: str, index: dict[str, Any]) -> str:
    """`{index.<key>}` placeholders come from the size's resolved `index` block (e.g. the relation to query)."""

    def repl(m: re.Match[str]) -> str:
        name = m.group(1)
        if name not in index:
            raise KeyError(f"block uses {{index.{name}}} but the index settings do not define it")
        return str(index[name])

    return INDEX_RE.sub(repl, block)


def _merge(base: dict[str, Any], over: dict[str, Any] | None) -> dict[str, Any]:
    out = {"index": dict(base.get("index") or {}), "ladder": dict(base.get("ladder") or {})}
    if over:
        out["index"].update(over.get("index") or {})
        if over.get("ladder"):
            out["ladder"] = dict(over["ladder"])  # a ladder override replaces the whole ladder
    return out


def resolve_settings(settings: dict[str, Any], family: Family, size: str, group: Group | None = None) -> dict[str, Any]:
    """defaults < datasets.<family>.<size> < groups[*/<k>] < groups[<filter>/*] < groups[<filter>/<k>]
    (exact groups share the filter's settings)."""
    cur = _merge({}, settings.get("defaults"))
    ds = ((settings.get("datasets") or {}).get(family.name) or {}).get(size)
    cur = _merge(cur, ds)
    if group is not None and ds and ds.get("groups"):
        for key in (f"*/{group.k}", f"{group.filter}/*", f"{group.filter}/{group.k}"):
            if key in ds["groups"]:
                cur = _merge(cur, ds["groups"][key])
    return cur


def ladder_points(ladder: dict[str, list[Any]]) -> list[dict[str, Any]]:
    """Cartesian product of the knob lists, in the order written."""
    if not ladder:
        return [{}]
    names = list(ladder)
    lists = [list(ladder[n]) if isinstance(ladder[n], (list, tuple)) else [ladder[n]] for n in names]
    return [dict(zip(names, combo)) for combo in itertools.product(*lists)]
