"""Exact top-depth neighbours per query, per filter case, by chunked float32 BLAS with per-query masks
(docs/contracts.md section 2, gt/<case>.npz)."""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterator
from typing import Any

import numpy as np

log = logging.getLogger(__name__)

MaskFn = Callable[[dict[str, np.ndarray], slice], np.ndarray]  # (block columns, query slice) -> [nq_sel, rows]


class TopK:
    """Running top-`depth` per query, smaller distance is better."""

    def __init__(self, nq: int, depth: int):
        self.depth = depth
        self.dists = np.full((nq, depth), np.inf, dtype=np.float32)
        self.ids = np.full((nq, depth), -1, dtype=np.int64)

    def update(self, qsel: slice, dists: np.ndarray, ids: np.ndarray) -> None:
        """Merge a block: `dists` [nq_sel, rows] (inf where masked out), `ids` [rows].

        The block is reduced to its own top-`depth` before the running top is touched. Pairing the
        ids with the full block first, as the obvious version does, materialises an int64 array the
        width of the block for every filter case of every block: at ten million rows and ten cases
        that is the single largest cost of preparing a dataset, and none of it is needed, because
        all but `depth` of those ids are about to be discarded.
        """
        depth = self.depth
        if dists.shape[1] > depth:
            part = np.argpartition(dists, depth - 1, axis=1)[:, :depth]
            blk_d = np.take_along_axis(dists, part, axis=1)
            blk_i = ids[part]
        else:
            blk_d = dists
            blk_i = np.broadcast_to(ids[None, :], dists.shape)
        cand_d = np.concatenate([self.dists[qsel], blk_d], axis=1)
        cand_i = np.concatenate([self.ids[qsel], blk_i], axis=1)
        if cand_d.shape[1] > depth:
            part = np.argpartition(cand_d, depth - 1, axis=1)[:, :depth]
            cand_d = np.take_along_axis(cand_d, part, axis=1)
            cand_i = np.take_along_axis(cand_i, part, axis=1)
        self.dists[qsel] = cand_d
        self.ids[qsel] = cand_i

    def finish(self) -> tuple[np.ndarray, np.ndarray]:
        order = np.argsort(self.dists, axis=1, kind="stable")
        d = np.take_along_axis(self.dists, order, axis=1)
        i = np.take_along_axis(self.ids, order, axis=1)
        i[~np.isfinite(d)] = -1
        return i.astype(np.int32), d


def block_distances(queries: np.ndarray, block: np.ndarray, metric: str, block_norms: np.ndarray | None = None) -> np.ndarray:
    """[nq, rows] distances, smaller is better: squared l2, or negative inner product."""
    s = queries @ block.T  # float32 BLAS
    if metric == "ip":
        return -s
    if block_norms is None:
        block_norms = (block.astype(np.float32) ** 2).sum(axis=1)
    qn = (queries ** 2).sum(axis=1, keepdims=True)
    d = qn + block_norms[None, :] - 2.0 * s
    np.maximum(d, 0.0, out=d)
    return d


def compute(
    queries: np.ndarray,
    blocks: Iterator[tuple[np.ndarray, np.ndarray, dict[str, np.ndarray]]],
    metric: str,
    depth: int,
    cases: dict[str, MaskFn],
    query_batch: int = 2000,
    progress: Callable[[int], None] | None = None,
) -> dict[str, dict[str, Any]]:
    """Run over base blocks `(ids, vectors, attribute columns)` once and return, per case,
    {'ids': [nq, depth] int32, 'dists': [nq, depth] float32, 'matches': [nq] int64}.

    Queries are processed in batches so the [nq, rows] distance block stays in cache-friendly sizes."""
    queries = np.ascontiguousarray(queries, dtype=np.float32)
    nq = len(queries)
    tops = {c: TopK(nq, depth) for c in cases}
    matches = {c: np.zeros(nq, dtype=np.int64) for c in cases}
    seen = 0
    for ids, vecs, cols in blocks:
        vecs = np.ascontiguousarray(vecs, dtype=np.float32)
        norms = (vecs ** 2).sum(axis=1) if metric == "l2" else None
        for qs in range(0, nq, query_batch):
            qsel = slice(qs, min(qs + query_batch, nq))
            d = block_distances(queries[qsel], vecs, metric, norms)
            for cname, mask_fn in cases.items():
                m = mask_fn(cols, qsel)
                if m is None:  # `none` case
                    dm = d
                else:
                    matches[cname][qsel] += m.sum(axis=1)
                    dm = np.where(m, d, np.float32(np.inf))
                tops[cname].update(qsel, dm, ids)
        seen += len(ids)
        if progress:
            progress(seen)
    out: dict[str, dict[str, Any]] = {}
    for cname, top in tops.items():
        i, dd = top.finish()
        mt = matches[cname] if cases[cname] is not _none_mask else np.full(nq, seen, dtype=np.int64)
        out[cname] = {"ids": i, "dists": dd, "matches": mt}
    return out


def _none_mask(cols: dict[str, np.ndarray], qsel: slice) -> None:  # sentinel for the unfiltered case
    return None


def none_mask() -> MaskFn:
    return _none_mask


def naive_topk(queries: np.ndarray, base: np.ndarray, metric: str, depth: int, mask: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    """Reference implementation for tests: full distance matrix, optional [nq, rows] mask."""
    d = block_distances(np.ascontiguousarray(queries, dtype=np.float32), np.ascontiguousarray(base, dtype=np.float32), metric)
    if mask is not None:
        d = np.where(mask, d, np.inf)
    order = np.argsort(d, axis=1, kind="stable")[:, :depth]
    dd = np.take_along_axis(d, order, axis=1)
    ids = order.astype(np.int32)
    ids[~np.isfinite(dd)] = -1
    return ids, dd.astype(np.float32)
