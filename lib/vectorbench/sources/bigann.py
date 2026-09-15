"""big-ann-benchmarks binary corpora: `<n:uint32><d:uint32>` header then n rows of d values.

Only the prefix that a size needs is downloaded, with HTTP range requests in row blocks that are cached
on disk, so `sift-128-1m` costs 128 MB, not 128 GB."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import numpy as np
import requests

from . import Block

log = logging.getLogger(__name__)

DTYPES = {"uint8": np.uint8, "int8": np.int8, "float32": np.float32}
HEADER = 8


class BigannSource:
    def __init__(self, spec: dict[str, Any], cache_dir: Path, dims: int):
        self.base_url = spec["base_url"]
        self.query_url = spec["query_url"]
        self.dtype = DTYPES[spec.get("dtype", "float32")]
        self.dims = dims
        self.block_rows = int(spec.get("block_rows", 100_000))
        self.cache = cache_dir / "bigann"
        self.cache.mkdir(parents=True, exist_ok=True)
        self._header: tuple[int, int] | None = None

    # ----------------------------------------------------------------- helpers
    def _row_bytes(self) -> int:
        return self.dims * np.dtype(self.dtype).itemsize

    def header(self) -> tuple[int, int]:
        if self._header is None:
            r = requests.get(self.base_url, headers={"Range": f"bytes=0-{HEADER - 1}"}, timeout=60)
            r.raise_for_status()
            n, d = np.frombuffer(r.content[:HEADER], dtype=np.uint32)
            if int(d) != self.dims:
                raise ValueError(f"{self.base_url}: file has {d} dims, family says {self.dims}")
            self._header = (int(n), int(d))
        return self._header

    def _fetch_range(self, start: int, end_inclusive: int, dest: Path) -> None:
        tmp = dest.with_suffix(dest.suffix + ".tmp")
        for attempt in range(5):
            try:
                with requests.get(self.base_url, headers={"Range": f"bytes={start}-{end_inclusive}"}, stream=True, timeout=120) as r:
                    r.raise_for_status()
                    if r.status_code != 206:
                        raise RuntimeError(f"server ignored the Range header (status {r.status_code})")
                    with tmp.open("wb") as f:
                        for chunk in r.iter_content(1 << 20):
                            f.write(chunk)
                want = end_inclusive - start + 1
                if tmp.stat().st_size != want:
                    raise RuntimeError(f"short read: {tmp.stat().st_size} of {want} bytes")
                tmp.replace(dest)
                return
            except Exception as e:  # noqa: BLE001
                log.warning("range %d-%d attempt %d failed: %s", start, end_inclusive, attempt + 1, e)
        raise RuntimeError(f"could not download bytes {start}-{end_inclusive} of {self.base_url}")

    def _block(self, index: int, rows_total: int) -> np.ndarray:
        n_rows_file, _ = self.header()
        first = index * self.block_rows
        last = min(first + self.block_rows, rows_total, n_rows_file)
        if first >= last:
            return np.empty((0, self.dims), dtype=self.dtype)
        rb = self._row_bytes()
        dest = self.cache / f"{Path(self.base_url).name}.rows{first}-{last}.bin"
        if not dest.exists():
            self._fetch_range(HEADER + first * rb, HEADER + last * rb - 1, dest)
        raw = np.fromfile(dest, dtype=self.dtype)
        return raw.reshape(last - first, self.dims)

    # ------------------------------------------------------------------- Source
    def stream(self, rows: int) -> Iterator[Block]:
        n_file, _ = self.header()
        if rows > n_file:
            raise ValueError(f"asked for {rows} rows, file has {n_file}")
        produced = 0
        index = 0
        while produced < rows:
            blk = self._block(index, rows)
            if len(blk) == 0:
                break
            produced += len(blk)
            index += 1
            yield Block(vectors=blk.astype(np.float32, copy=False))

    def queries(self, count: int) -> Block:
        dest = self.cache / Path(self.query_url).name
        if not dest.exists():
            tmp = dest.with_suffix(".tmp")
            with requests.get(self.query_url, stream=True, timeout=300) as r:
                r.raise_for_status()
                with tmp.open("wb") as f:
                    for chunk in r.iter_content(1 << 20):
                        f.write(chunk)
            tmp.replace(dest)
        raw = dest.read_bytes()
        n, d = np.frombuffer(raw[:HEADER], dtype=np.uint32)
        if int(d) != self.dims:
            raise ValueError(f"{self.query_url}: {d} dims, family says {self.dims}")
        q = np.frombuffer(raw[HEADER:], dtype=self.dtype).reshape(int(n), self.dims)
        if count > len(q):
            raise ValueError(f"query file has {len(q)} queries, family asks for {count}")
        return Block(vectors=q[:count].astype(np.float32))
