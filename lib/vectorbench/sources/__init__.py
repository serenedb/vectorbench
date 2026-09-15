"""Corpus sources. Each yields the family's row stream in a fixed order (so every size is a prefix of
the next) plus the query pool, as float32 vectors with optional string columns."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

import numpy as np


@dataclass
class Block:
    vectors: np.ndarray  # [n, dims] float32
    extra: dict[str, np.ndarray] = field(default_factory=dict)  # lang, title as object arrays

    def __len__(self) -> int:
        return len(self.vectors)


class Source(Protocol):
    def stream(self, rows: int) -> Iterator[Block]:
        """Yield blocks in the canonical order until `rows` rows have been produced (the last block
        may be cut). Deterministic."""

    def queries(self, count: int) -> Block:
        """The query pool, disjoint from every row `stream` can produce."""


def make_source(spec: dict[str, Any], cache_dir: Path, dims: int) -> Source:
    kind = spec.get("kind")
    if kind == "hf":
        from .hf import HfSource

        return HfSource(spec, cache_dir, dims)
    if kind == "bigann":
        from .bigann import BigannSource

        return BigannSource(spec, cache_dir, dims)
    raise ValueError(f"unknown source kind {kind!r}")
