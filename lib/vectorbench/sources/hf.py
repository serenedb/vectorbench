"""Hugging Face parquet corpora split by language directory (Cohere Wikipedia layout).

Canonical stream: the base languages' shard files are read in ascending name order, and rows are
interleaved across languages in chunks of `interleave_rows`, so every prefix is multilingual and every
size is a prefix of the next. `langs` are the query languages: the last shard file of each is the query
pool and never enters the stream. `base_langs: all` streams every language of the corpus (query
languages first, the rest by name); without it the stream is the query languages alone.

`local_dir` reads the same layout (`<lang>/<file>.parquet`) from a local copy instead of the Hub."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
import pyarrow.parquet as pq

from . import Block

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Piece:
    """`rows` consecutive rows of one shard file, starting at row `start`."""

    path: str
    lang: str
    start: int
    rows: int


@dataclass
class _Cursor:
    lang: str
    files: list[str]
    file: int = 0
    offset: int = 0
    exhausted: bool = False


class HfSource:
    def __init__(self, spec: dict[str, Any], cache_dir: Path, dims: int):
        self.repo = spec["repo"]
        self.langs = list(spec["langs"])
        self.base_langs = spec.get("base_langs")
        cols = spec.get("columns") or {}
        self.emb_col = cols.get("emb", "emb")
        self.title_col = cols.get("title")
        self.interleave_rows = int(spec.get("interleave_rows", 10000))
        self.dims = dims
        self.local_dir = Path(spec["local_dir"]) if spec.get("local_dir") else None
        self.cache = cache_dir / "hf"
        if self.local_dir is None:
            self.cache.mkdir(parents=True, exist_ok=True)
        self._files: dict[str, list[str]] | None = None
        self._num_rows: dict[str, int] = {}
        self._open: dict[str, pq.ParquetFile] = {}

    # ----------------------------------------------------------------- helpers
    def _listing(self) -> dict[str, list[str]]:
        """Every language directory of the corpus and its parquet files, by name."""
        if self.local_dir is not None:
            out: dict[str, list[str]] = {}
            for d in sorted(p for p in self.local_dir.iterdir() if p.is_dir()):
                names = sorted(f"{d.name}/{f.name}" for f in d.glob("*.parquet"))
                if names:
                    out[d.name] = names
            return out
        from huggingface_hub import HfApi

        api = HfApi()
        wanted = self.langs if self.base_langs is None else None if self.base_langs == "all" else sorted(set(self.langs) | set(self.base_langs))
        if wanted is None:
            wanted = sorted(e.path for e in api.list_repo_tree(self.repo, repo_type="dataset") if "/" not in e.path and "." not in e.path)
        out = {}
        for lang in wanted:
            entries = api.list_repo_tree(self.repo, path_in_repo=lang, repo_type="dataset")
            names = sorted(e.path for e in entries if e.path.endswith(".parquet"))
            if names:
                out[lang] = names
        return out

    def files(self) -> dict[str, list[str]]:
        if self._files is None:
            listing = self._listing()
            for lang in self.langs:
                if len(listing.get(lang, [])) < 2:
                    raise ValueError(f"{self.repo}/{lang}: need at least 2 parquet shards (base + query pool), found {len(listing.get(lang, []))}")
            self._files = listing
        return self._files

    def stream_langs(self) -> list[str]:
        """Languages of the stream, in interleave order."""
        if self.base_langs is None:
            return list(self.langs)
        files = self.files()
        others = sorted(files) if self.base_langs == "all" else list(self.base_langs)
        for lang in others:
            if lang not in files:
                raise ValueError(f"{self.repo}: base language {lang!r} has no parquet shards")
        return list(self.langs) + [lang for lang in others if lang not in self.langs]

    def base_files(self, lang: str) -> list[str]:
        files = self.files()[lang]
        return files[:-1] if lang in self.langs else files

    def download(self, path_in_repo: str) -> Path:
        if self.local_dir is not None:
            p = self.local_dir / path_in_repo
            if not p.exists():
                raise FileNotFoundError(p)
            return p
        from huggingface_hub import hf_hub_download

        return Path(hf_hub_download(self.repo, path_in_repo, repo_type="dataset", cache_dir=str(self.cache)))

    def num_rows(self, path: str) -> int:
        n = self._num_rows.get(path)
        if n is None:
            n = pq.read_metadata(path).num_rows
            self._num_rows[path] = n
        return n

    def _parquet(self, path: str) -> pq.ParquetFile:
        pf = self._open.get(path)
        if pf is None:
            if len(self._open) >= 64:
                self._open.clear()
            pf = pq.ParquetFile(path)
            self._open[path] = pf
        return pf

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
    def plan(self, rows: int) -> list[Piece]:
        """The first `rows` rows of the stream as file pieces, in stream order. Files are fetched only
        when the stream reaches them."""
        cursors = [_Cursor(lang, files, exhausted=not files) for lang in self.stream_langs() for files in [self.base_files(lang)]]
        pieces: list[Piece] = []
        produced = 0
        while produced < rows:
            progressed = False
            for cur in cursors:
                if cur.exhausted or produced >= rows:
                    continue
                need = min(self.interleave_rows, rows - produced)
                got = 0
                while got < need:
                    if cur.file >= len(cur.files):
                        cur.exhausted = True
                        break
                    path = str(self.download(cur.files[cur.file]))
                    avail = self.num_rows(path) - cur.offset
                    if avail <= 0:
                        cur.file, cur.offset = cur.file + 1, 0
                        continue
                    take = min(need - got, avail)
                    pieces.append(Piece(path, cur.lang, cur.offset, take))
                    got += take
                    cur.file, cur.offset = (cur.file + 1, 0) if take == avail else (cur.file, cur.offset + take)
                if got:
                    progressed = True
                    produced += got
            if not progressed:
                raise ValueError(f"{self.repo}: corpus exhausted after {produced} rows, {rows} requested")
        return pieces

    def read_piece(self, piece: Piece) -> Block:
        pf = self._parquet(piece.path)
        md = pf.metadata
        cols = [self.emb_col] + ([self.title_col] if self.title_col else [])
        groups: list[int] = []
        first = 0
        lo = 0
        for g in range(md.num_row_groups):
            n = md.row_group(g).num_rows
            if lo + n > piece.start and lo < piece.start + piece.rows:
                if not groups:
                    first = lo
                groups.append(g)
            lo += n
        t = pf.read_row_groups(groups, columns=cols).slice(piece.start - first, piece.rows)
        if len(t) != piece.rows:
            raise ValueError(f"{piece.path}: {len(t)} rows at {piece.start}, expected {piece.rows}")
        return self.to_block(t, piece.lang)

    def stream(self, rows: int) -> Iterator[Block]:
        for piece in self.plan(rows):
            yield self.read_piece(piece)

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
