"""Hugging Face parquet corpora split by language directory (Cohere Wikipedia layout).

Canonical stream: the languages' shard files are read in ascending name order, and rows are
interleaved across languages in chunks of `interleave_rows`, so every prefix is multilingual and every
size is a prefix of the next. The last shard file of every language is the query pool and never enters
the stream."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import numpy as np
import pyarrow.parquet as pq
from huggingface_hub import HfApi, hf_hub_download

from . import Block

log = logging.getLogger(__name__)


class _LangReader:
    """Sequential row reader over one language's shard files (all but the last)."""

    def __init__(self, source: "HfSource", lang: str, files: list[str]):
        self.source = source
        self.lang = lang
        self.files = files
        self.file_idx = 0
        self.batches: Iterator[Any] | None = None
        self.pending: Block | None = None
        self.exhausted = not files

    def _open_next(self) -> bool:
        if self.file_idx >= len(self.files):
            self.exhausted = True
            return False
        path = self.source.download(self.files[self.file_idx])
        self.file_idx += 1
        pf = pq.ParquetFile(path)
        cols = [self.source.emb_col] + ([self.source.title_col] if self.source.title_col else [])
        self.batches = pf.iter_batches(batch_size=self.source.interleave_rows, columns=cols)
        return True

    def take(self, n: int) -> Block | None:
        """Up to n rows; None when the language is exhausted."""
        vecs: list[np.ndarray] = []
        titles: list[np.ndarray] = []
        got = 0
        while got < n:
            if self.pending is not None:
                blk = self.pending
                self.pending = None
            else:
                if self.batches is None and not self._open_next():
                    break
                try:
                    rb = next(self.batches)  # type: ignore[arg-type]
                except StopIteration:
                    self.batches = None
                    continue
                blk = self.source.to_block(rb, self.lang)
            need = n - got
            if len(blk) > need:
                self.pending = Block(blk.vectors[need:], {k: v[need:] for k, v in blk.extra.items()})
                blk = Block(blk.vectors[:need], {k: v[:need] for k, v in blk.extra.items()})
            vecs.append(blk.vectors)
            titles.append(blk.extra["title"])
            got += len(blk)
        if got == 0:
            return None
        return Block(
            np.concatenate(vecs),
            {"title": np.concatenate(titles), "lang": np.array([self.lang] * got, dtype=object)},
        )


class HfSource:
    def __init__(self, spec: dict[str, Any], cache_dir: Path, dims: int):
        self.repo = spec["repo"]
        self.langs = list(spec["langs"])
        cols = spec.get("columns") or {}
        self.emb_col = cols.get("emb", "emb")
        self.title_col = cols.get("title")
        self.interleave_rows = int(spec.get("interleave_rows", 10000))
        self.dims = dims
        self.cache = cache_dir / "hf"
        self.cache.mkdir(parents=True, exist_ok=True)
        self._files: dict[str, list[str]] | None = None

    # ----------------------------------------------------------------- helpers
    def files(self) -> dict[str, list[str]]:
        if self._files is None:
            api = HfApi()
            out: dict[str, list[str]] = {}
            for lang in self.langs:
                entries = api.list_repo_tree(self.repo, path_in_repo=lang, repo_type="dataset")
                names = sorted(e.path for e in entries if e.path.endswith(".parquet"))
                if len(names) < 2:
                    raise ValueError(f"{self.repo}/{lang}: need at least 2 parquet shards (base + query pool), found {len(names)}")
                out[lang] = names
            self._files = out
        return self._files

    def download(self, path_in_repo: str) -> Path:
        return Path(hf_hub_download(self.repo, path_in_repo, repo_type="dataset", cache_dir=str(self.cache)))

    def to_block(self, batch: Any, lang: str) -> Block:
        emb = batch.column(self.emb_col)
        vec = np.asarray(emb.combine_chunks().flatten().to_numpy(zero_copy_only=False), dtype=np.float32) if hasattr(emb, "combine_chunks") else np.asarray(emb.flatten().to_numpy(zero_copy_only=False), dtype=np.float32)
        vec = vec.reshape(len(batch), -1)
        if vec.shape[1] != self.dims:
            raise ValueError(f"{self.repo}: {vec.shape[1]} dims, family says {self.dims}")
        if self.title_col:
            titles = np.array([t if t is not None else "" for t in batch.column(self.title_col).to_pylist()], dtype=object)
        else:
            titles = np.array([""] * len(batch), dtype=object)
        return Block(vec, {"title": titles, "lang": np.array([lang] * len(batch), dtype=object)})

    # ------------------------------------------------------------------- Source
    def stream(self, rows: int) -> Iterator[Block]:
        files = self.files()
        readers = [_LangReader(self, lang, files[lang][:-1]) for lang in self.langs]
        produced = 0
        while produced < rows:
            progressed = False
            for rd in readers:
                if rd.exhausted or produced >= rows:
                    continue
                blk = rd.take(min(self.interleave_rows, rows - produced))
                if blk is None:
                    continue
                progressed = True
                produced += len(blk)
                yield blk
            if not progressed:
                raise ValueError(f"{self.repo}: corpus exhausted after {produced} rows, {rows} requested")

    def queries(self, count: int) -> Block:
        files = self.files()
        per_lang = [count // len(self.langs)] * len(self.langs)
        for i in range(count - sum(per_lang)):
            per_lang[i] += 1
        blocks: list[Block] = []
        for lang, n in zip(self.langs, per_lang):
            path = self.download(files[lang][-1])
            pf = pq.ParquetFile(path)
            got: list[Block] = []
            have = 0
            cols = [self.emb_col] + ([self.title_col] if self.title_col else [])
            for rb in pf.iter_batches(batch_size=min(n, 4096), columns=cols):
                blk = self.to_block(rb, lang)
                need = n - have
                if len(blk) > need:
                    blk = Block(blk.vectors[:need], {k: v[:need] for k, v in blk.extra.items()})
                got.append(blk)
                have += len(blk)
                if have >= n:
                    break
            if have < n:
                raise ValueError(f"{self.repo}/{lang}: query pool has only {have} rows, need {n}")
            blocks.append(Block(np.concatenate([b.vectors for b in got]), {k: np.concatenate([b.extra[k] for b in got]) for k in ("title", "lang")}))
        return Block(np.concatenate([b.vectors for b in blocks]), {k: np.concatenate([b.extra[k] for b in blocks]) for k in ("title", "lang")})
