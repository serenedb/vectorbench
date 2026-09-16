"""`vectorbench prepare`: materialize `<family>-<size>` (docs/contracts.md section 2).

Steps: base shards (vectors + attributes, cluster filled after k-means), queries, per-case query
arguments, ground truth per case, manifest. Idempotent: existing shards with a matching manifest entry
are reused, and a smaller prepared size of the same family donates its shards when its centroids were
trained on the same rows."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import logging
import os
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq

from . import __version__, attributes, groundtruth
from .families import Family
from .sources import Block, make_source

log = logging.getLogger(__name__)

BASE_COLUMNS = ["id", "emb", "cat10", "cat100", "cat1000", "num", "ts", "cluster", "lang", "title"]


def data_dir() -> Path:
    d = os.environ.get("VECTORBENCH_DATA_DIR")
    if not d:
        raise SystemExit("VECTORBENCH_DATA_DIR is not set (root directory for prepared data)")
    return Path(d).expanduser()


def dataset_dir(family: Family, size: str, root: Path | None = None) -> Path:
    return (root or data_dir()) / family.dataset_id(size)


def base_schema(dims: int) -> pa.Schema:
    return pa.schema(
        [
            ("id", pa.int64()),
            ("emb", pa.list_(pa.float32(), dims)),
            ("cat10", pa.int16()),
            ("cat100", pa.int16()),
            ("cat1000", pa.int16()),
            ("num", pa.int32()),
            ("ts", pa.timestamp("s")),
            ("cluster", pa.int16()),
            ("lang", pa.string()),
            ("title", pa.string()),
        ]
    )


def _fsl(vectors: np.ndarray, dims: int) -> pa.Array:
    flat = pa.array(np.ascontiguousarray(vectors, dtype=np.float32).ravel(), type=pa.float32())
    return pa.FixedSizeListArray.from_arrays(flat, dims)


def shard_table(ids: np.ndarray, vectors: np.ndarray, extra: dict[str, np.ndarray], cluster: np.ndarray, dims: int) -> pa.Table:
    syn = attributes.synthetic_columns(ids)
    n = len(ids)
    lang = extra.get("lang", np.array([""] * n, dtype=object))
    title = extra.get("title", np.array([""] * n, dtype=object))
    return pa.table(
        {
            "id": pa.array(ids, type=pa.int64()),
            "emb": _fsl(vectors, dims),
            "cat10": pa.array(syn["cat10"], type=pa.int16()),
            "cat100": pa.array(syn["cat100"], type=pa.int16()),
            "cat1000": pa.array(syn["cat1000"], type=pa.int16()),
            "num": pa.array(syn["num"], type=pa.int32()),
            "ts": pa.array(syn["ts"].astype("datetime64[s]"), type=pa.timestamp("s")),
            "cluster": pa.array(cluster.astype(np.int16), type=pa.int16()),
            "lang": pa.array([str(x) for x in lang], type=pa.string()),
            "title": pa.array([str(x) if x is not None else "" for x in title], type=pa.string()),
        },
        schema=base_schema(dims),
    )


def read_shard(path: Path, columns: list[str] | None = None) -> pa.Table:
    return pq.read_table(path, columns=columns)


def table_vectors(t: pa.Table, dims: int) -> np.ndarray:
    col = t.column("emb").combine_chunks()
    return np.asarray(col.flatten().to_numpy(zero_copy_only=False), dtype=np.float32).reshape(len(t), dims)


def table_columns(t: pa.Table, names: list[str]) -> dict[str, np.ndarray]:
    out: dict[str, np.ndarray] = {}
    for n in names:
        c = t.column(n)
        out[n] = np.asarray(c.to_pylist(), dtype=object) if pa.types.is_string(c.type) else c.to_numpy()
    return out


def sha256_file(path: Path) -> str:
    hsh = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 22), b""):
            hsh.update(chunk)
    return hsh.hexdigest()


def kmeans(x: np.ndarray, k: int, iters: int = 25, seed: int = 0) -> np.ndarray:
    """Plain Lloyd k-means with k-means++ seeding on a sample, float32, fixed seed."""
    rng = np.random.default_rng(seed)
    x = np.ascontiguousarray(x, dtype=np.float32)
    n = len(x)
    if n < k:
        raise ValueError(f"k-means: {n} rows for {k} clusters")
    # k-means++ on a sample of at most 50k rows for speed
    sample = x[rng.choice(n, size=min(n, 50_000), replace=False)]
    cents = [sample[rng.integers(len(sample))]]
    d2 = ((sample - cents[0]) ** 2).sum(axis=1)
    for _ in range(1, k):
        probs = d2 / d2.sum() if d2.sum() > 0 else np.full(len(sample), 1.0 / len(sample))
        c = sample[rng.choice(len(sample), p=probs)]
        cents.append(c)
        d2 = np.minimum(d2, ((sample - c) ** 2).sum(axis=1))
    centroids = np.stack(cents).astype(np.float32)
    for _ in range(iters):
        assign = attributes.assign_clusters(x, centroids)
        new = centroids.copy()
        for c in range(k):
            m = assign == c
            if m.any():
                new[c] = x[m].mean(axis=0)
            else:  # re-seed an empty cluster with a random row
                new[c] = x[rng.integers(n)]
        shift = float(((new - centroids) ** 2).sum())
        centroids = new
        if shift < 1e-6:
            break
    return centroids


class Preparer:
    def __init__(self, family: Family, size: str, root: Path | None = None, workers: int | None = None):
        self.family = family
        self.size = size
        self.root = root or data_dir()
        self.out = dataset_dir(family, size, self.root)
        self.rows = family.rows(size)
        self.cache = self.root / "_cache" / family.name
        self.n_shards = (self.rows + family.shard_rows - 1) // family.shard_rows
        self.source = make_source(family.source, self.cache, family.dims)
        self.train_rows = min(family.cluster_train_rows, self.rows)

    # ------------------------------------------------------------------ paths
    def shard_path(self, i: int) -> Path:
        return self.out / "base" / f"part_{i:05d}.parquet"

    def manifest_path(self) -> Path:
        return self.out / "manifest.json"

    # -------------------------------------------------------------- donors
    def _donor(self) -> Path | None:
        """A smaller prepared size of this family whose shards are identical (same centroid training rows)."""
        best: tuple[int, Path] | None = None
        for s, n in self.family.sizes.items():
            if s == self.size or n >= self.rows:
                continue
            d = dataset_dir(self.family, s, self.root)
            mp = d / "manifest.json"
            if not mp.exists():
                continue
            m = json.loads(mp.read_text())
            if m.get("cluster_train_rows") != self.train_rows or m.get("tool_version") != __version__:
                continue
            if best is None or n > best[0]:
                best = (n, d)
        return best[1] if best else None

    # -------------------------------------------------------------- shards
    def _stream_rows(self) -> Iterator[tuple[np.ndarray, Block]]:
        produced = 0
        for blk in self.source.stream(self.rows):
            ids = np.arange(produced, produced + len(blk), dtype=np.int64)
            produced += len(blk)
            yield ids, blk

    def write_shards(self) -> list[Path]:
        (self.out / "base").mkdir(parents=True, exist_ok=True)
        donor = self._donor()
        paths = [self.shard_path(i) for i in range(self.n_shards)]
        if donor is not None:
            dm = json.loads((donor / "manifest.json").read_text())
            for i, sh in enumerate(dm["shards"]):
                src = donor / sh["path"]
                dst = paths[i]
                if i < self.n_shards and src.exists() and not dst.exists() and sh["rows"] == self.family.shard_rows:
                    try:
                        os.link(src, dst)
                    except OSError:
                        dst.write_bytes(src.read_bytes())
                    log.info("shard %d reused from %s", i, donor.name)
        missing = [i for i, p in enumerate(paths) if not p.exists()]
        if not missing:
            return paths
        # Pass 1: stage vectors and extra columns per shard (cluster is filled after k-means).
        stage = self.out / "_stage"
        stage.mkdir(exist_ok=True)
        buf_v: list[np.ndarray] = []
        buf_e: dict[str, list[np.ndarray]] = {"lang": [], "title": []}
        buf_ids: list[np.ndarray] = []
        buffered = 0
        shard_i = 0
        t0 = time.time()
        staged: dict[int, Path] = {}

        def flush(final: bool = False) -> None:
            nonlocal buf_v, buf_e, buf_ids, buffered, shard_i
            while buffered >= self.family.shard_rows or (final and buffered > 0):
                take = min(self.family.shard_rows, buffered)
                v = np.concatenate(buf_v)
                ids = np.concatenate(buf_ids)
                ex = {k: np.concatenate(buf_e[k]) for k in buf_e}
                v_s, v_r = v[:take], v[take:]
                i_s, i_r = ids[:take], ids[take:]
                e_s = {k: ex[k][:take] for k in ex}
                e_r = {k: ex[k][take:] for k in ex}
                if shard_i in missing:
                    p = stage / f"part_{shard_i:05d}.npz"
                    np.savez(p, ids=i_s, vectors=v_s, lang=e_s["lang"].astype(str), title=e_s["title"].astype(str))
                    staged[shard_i] = p
                    log.info("staged shard %d (%d rows, %.0fs)", shard_i, take, time.time() - t0)
                shard_i += 1
                buf_v, buf_ids = [v_r], [i_r]
                buf_e = {k: [e_r[k]] for k in e_r}
                buffered = len(v_r)

        for ids, blk in self._stream_rows():
            buf_v.append(blk.vectors)
            buf_ids.append(ids)
            n = len(blk)
            buf_e["lang"].append(blk.extra.get("lang", np.array([""] * n, dtype=object)))
            buf_e["title"].append(blk.extra.get("title", np.array([""] * n, dtype=object)))
            buffered += n
            flush()
        flush(final=True)
        # k-means on the first train_rows rows
        centroids = self.centroids(staged, paths)
        # Pass 2: write parquet shards with clusters
        for i in sorted(staged):
            z = np.load(staged[i], allow_pickle=False)
            vec = z["vectors"]
            cl = attributes.assign_clusters(vec, centroids)
            table = shard_table(z["ids"], vec, {"lang": z["lang"].astype(object), "title": z["title"].astype(object)}, cl, self.family.dims)
            tmp = paths[i].with_suffix(".tmp.parquet")
            pq.write_table(table, tmp, compression="none", row_group_size=min(10_000, len(table)))
            tmp.replace(paths[i])
            staged[i].unlink()
            log.info("wrote %s", paths[i].name)
        try:
            stage.rmdir()
        except OSError:
            pass
        return paths

    def centroids(self, staged: dict[int, Path], paths: list[Path]) -> np.ndarray:
        cpath = self.out / "centroids.npy"
        if cpath.exists():
            return np.load(cpath)
        donor = self._donor()
        if donor is not None and (donor / "centroids.npy").exists():
            c = np.load(donor / "centroids.npy")
            np.save(cpath, c)
            return c
        need = self.train_rows
        parts: list[np.ndarray] = []
        have = 0
        for i in range(self.n_shards):
            if have >= need:
                break
            if i in staged:
                v = np.load(staged[i], allow_pickle=False)["vectors"]
            else:
                v = table_vectors(read_shard(paths[i], ["emb"]), self.family.dims)
            parts.append(v[: need - have])
            have += len(parts[-1])
        x = np.concatenate(parts)
        log.info("k-means: %d clusters on %d rows", self.family.cluster_k, len(x))
        c = kmeans(x, self.family.cluster_k)
        np.save(cpath, c)
        return c

    # -------------------------------------------------------------- queries
    def write_queries(self, centroids: np.ndarray) -> tuple[np.ndarray, dict[str, np.ndarray]]:
        qp = self.out / "queries.parquet"
        nq = self.family.queries_count
        if qp.exists():
            t = pq.read_table(qp)
            vec = table_vectors(t, self.family.dims)
            info = {"cluster": t.column("cluster").to_numpy(), "lang": np.asarray(t.column("lang").to_pylist(), dtype=object)}
            return vec, info
        blk = self.source.queries(nq)
        vec = np.ascontiguousarray(blk.vectors, dtype=np.float32)
        lang = blk.extra.get("lang", np.array([""] * nq, dtype=object))
        cl = attributes.assign_clusters(vec, centroids)
        t = pa.table(
            {
                "qid": pa.array(np.arange(nq, dtype=np.int32), type=pa.int32()),
                "emb": _fsl(vec, self.family.dims),
                "cluster": pa.array(cl, type=pa.int16()),
                "lang": pa.array([str(x) for x in lang], type=pa.string()),
            }
        )
        pq.write_table(t, qp, compression="none")
        return vec, {"cluster": cl, "lang": lang}

    def write_query_args(self, qvec: np.ndarray, qinfo_base: dict[str, np.ndarray], centroids: np.ndarray) -> dict[str, dict[str, np.ndarray]]:
        nq = len(qvec)
        qids = np.arange(nq, dtype=np.int64)
        qinfo = {
            "query_cluster": qinfo_base["cluster"],
            "far_cluster": attributes.far_clusters(qvec, centroids),
            "query_lang": qinfo_base["lang"],
            "langs": self.family.langs(),
        }
        per_case: dict[str, dict[str, np.ndarray]] = {}
        rows_case: list[str] = []
        rows_qid: list[np.ndarray] = []
        cols: dict[str, list[np.ndarray]] = {k: [] for k in attributes.ARG_COLUMNS}
        for cname, spec in self.family.filter_cases.items():
            args = attributes.query_args(cname, spec, qids, qinfo)
            per_case[cname] = args
            rows_case.extend([cname] * nq)
            rows_qid.append(qids.astype(np.int32))
            for k in attributes.ARG_COLUMNS:
                cols[k].append(args[k])
        t = pa.table(
            {
                "case": pa.array(rows_case, type=pa.string()),
                "qid": pa.array(np.concatenate(rows_qid), type=pa.int32()),
                "v": pa.array(np.concatenate(cols["v"]), type=pa.int64()),
                "lo": pa.array(np.concatenate(cols["lo"]), type=pa.int64()),
                "hi": pa.array(np.concatenate(cols["hi"]), type=pa.int64()),
                "v2": pa.array(np.concatenate(cols["v2"]), type=pa.int64()),
                "s": pa.array([str(x) for x in np.concatenate(cols["s"])], type=pa.string()),
            }
        )
        pq.write_table(t, self.out / "query_args.parquet", compression="none")
        return per_case

    # ------------------------------------------------------------ ground truth
    def _blocks(self, paths: list[Path]) -> Iterator[tuple[np.ndarray, np.ndarray, dict[str, np.ndarray]]]:
        for p in paths:
            pf = pq.ParquetFile(p)
            for rb in pf.iter_batches(batch_size=20_000, columns=BASE_COLUMNS):
                t = pa.Table.from_batches([rb])
                ids = t.column("id").to_numpy()
                vec = table_vectors(t, self.family.dims)
                cols = table_columns(t, ["cat10", "cat100", "cat1000", "num", "cluster", "lang"])
                yield ids, vec, cols

    def write_groundtruth(self, paths: list[Path], qvec: np.ndarray, per_case_args: dict[str, dict[str, np.ndarray]]) -> dict[str, dict[str, Any]]:
        gtdir = self.out / "gt"
        gtdir.mkdir(exist_ok=True)
        todo = {c for c in self.family.filter_cases if not (gtdir / f"{c}.npz").exists()}
        summary: dict[str, dict[str, Any]] = {}
        if todo:
            cases: dict[str, groundtruth.MaskFn] = {}
            for cname in todo:
                spec = self.family.filter_cases[cname]
                if not spec:
                    cases[cname] = groundtruth.none_mask()
                else:
                    args = per_case_args[cname]
                    cases[cname] = (lambda spec=spec, args=args: (lambda cols, qsel: attributes.predicate_mask(spec, cols, args, qsel)))()
            t0 = time.time()

            def progress(seen: int) -> None:
                log.info("ground truth: %d / %d rows (%.0fs)", seen, self.rows, time.time() - t0)

            res = groundtruth.compute(qvec, self._blocks(paths), self.family.metric, self.family.gt_depth, cases, progress=progress)
            for cname, r in res.items():
                np.savez(gtdir / f"{cname}.npz", ids=r["ids"], dists=r["dists"], matches=r["matches"])
        for cname in self.family.filter_cases:
            z = np.load(gtdir / f"{cname}.npz")
            m = z["matches"]
            summary[cname] = {"matches_median": int(np.median(m)), "matches_min": int(m.min()), "matches_max": int(m.max())}
        return summary

    # ---------------------------------------------------------------- manifest
    def write_manifest(self, paths: list[Path], gt_summary: dict[str, Any], norms: dict[str, float]) -> dict[str, Any]:
        shards = []
        for p in paths:
            md = pq.read_metadata(p)
            shards.append({"path": str(p.relative_to(self.out)), "rows": md.num_rows, "sha256": sha256_file(p)})
        manifest = {
            "family": self.family.name,
            "size": self.size,
            "dataset": self.family.dataset_id(self.size),
            "rows": int(sum(s["rows"] for s in shards)),
            "nq": self.family.queries_count,
            "dims": self.family.dims,
            "metric": self.family.metric,
            "gt_depth": self.family.gt_depth,
            "shard_rows": self.family.shard_rows,
            "cluster_k": self.family.cluster_k,
            "cluster_train_rows": self.train_rows,
            "shards": shards,
            "norms": norms,
            "attributes": BASE_COLUMNS[2:],
            "filter_cases": self.family.filter_cases,
            "groundtruth": gt_summary,
            "queries": [{"id": q.id, "filter": q.filter, "k": q.k, "recall": q.recall}
                        for q in self.family.queries_for(self.size)],
            "created": dt.datetime.now(dt.UTC).isoformat(timespec="seconds"),
            "tool_version": __version__,
        }
        tmp = self.manifest_path().with_suffix(".tmp")
        tmp.write_text(json.dumps(manifest, indent=1))
        tmp.replace(self.manifest_path())
        return manifest

    def norm_stats(self, paths: list[Path]) -> dict[str, float]:
        v = table_vectors(read_shard(paths[0], ["emb"]), self.family.dims)
        n = np.sqrt((v.astype(np.float64) ** 2).sum(axis=1))
        return {"min": float(n.min()), "p50": float(np.median(n)), "mean": float(n.mean()), "max": float(n.max()), "sample_rows": int(len(n))}

    # -------------------------------------------------------------------- run
    def run(self) -> dict[str, Any]:
        log.info("prepare %s -> %s", self.family.dataset_id(self.size), self.out)
        self.out.mkdir(parents=True, exist_ok=True)
        paths = self.write_shards()
        centroids = np.load(self.out / "centroids.npy")
        qvec, qinfo = self.write_queries(centroids)
        per_case = self.write_query_args(qvec, qinfo, centroids)
        gt_summary = self.write_groundtruth(paths, qvec, per_case)
        manifest = self.write_manifest(paths, gt_summary, self.norm_stats(paths))
        log.info("done: %d rows, %d queries, %d cases", manifest["rows"], manifest["nq"], len(gt_summary))
        return manifest


def load_manifest(family: Family, size: str, root: Path | None = None) -> dict[str, Any]:
    p = dataset_dir(family, size, root) / "manifest.json"
    if not p.exists():
        raise SystemExit(f"{family.dataset_id(size)} is not prepared (no {p}); run: vectorbench prepare --dataset {family.dataset_id(size)}")
    return json.loads(p.read_text())
