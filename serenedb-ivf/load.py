"""SereneDB load recipe (called by ./load). Environment per docs/contracts.md section 4.

Index kind comes from VB_INDEX_KIND (settings.yml env: index_kind) so the IVF and HNSW participants
share this file; index parameters come from VB_INDEX_<KEY> (the resolved `index` block).

Three recipes, chosen by VB_INDEX_STORAGE:

  search  CREATE TABLE ... WITH (storage = 'search'); CREATE INDEX on the empty table; INSERT every
          shard through the index (rows live in the index; backfill of an existing search table is
          not implemented yet, so the index must exist before the rows do). Query relation: items.
  view    CREATE VIEW items over read_parquet(shards); CREATE INDEX on the view (synchronous build,
          no table copy, the colleague's SearchBench-dev recipe). Query relation: items_vec.
  table   CREATE TABLE (transactional); CREATE INDEX as a secondary index; INSERT. Query relation:
          whatever the planner accelerates (items_vec on releases that do not rewrite base-table
          scans).
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import psycopg

PORT = int(os.environ.get("VB_PORT", "5499"))
KIND = os.environ.get("VB_INDEX_KIND", "ivf")
METRIC = os.environ.get("VECTORBENCH_METRIC", "ip")
DIMS = int(os.environ["VECTORBENCH_DIMS"])
DSDIR = Path(os.environ["VECTORBENCH_DATASET_DIR"])
QUANT = os.environ.get("VB_INDEX_QUANT", "sq8")
POSTING = os.environ.get("VB_INDEX_POSTING_SIZE")
SAMPLE = os.environ.get("VB_INDEX_SAMPLE_FACTOR")
M = os.environ.get("VB_INDEX_M")
EFC = os.environ.get("VB_INDEX_EF_CONSTRUCTION")
STORAGE = os.environ.get("VB_INDEX_STORAGE", "search")
THREADS = int(os.environ.get("VB_INDEX_THREADS") or (os.cpu_count() or 8))
# sdb_metrics keys a search table's index by the table oid, a secondary or view index by the index oid.
METRIC_REL = "items" if STORAGE == "search" else "items_vec"
STABLE_POLLS = 5  # consecutive 2-second polls with an unchanged segment count and idle compaction
POLL_S = 2.0
COLUMNS = ["id", "cat10", "cat100", "cat1000", "num", "ts", "cluster", "lang", "title"]
KEY_COLUMNS = ["id", "cat10", "cat100", "cat1000", "num", "cluster", "lang"]


def log(msg: str) -> None:
    print(msg, flush=True)


def connect() -> psycopg.Connection:
    return psycopg.connect(host="127.0.0.1", port=PORT, user="postgres", dbname="postgres", autocommit=True)


def opclass() -> str:
    opts = [f"metric = '{METRIC}'", f"quant = '{QUANT}'"]
    if KIND == "hnsw":
        if M:
            opts.append(f"m = {int(M)}")
        if EFC:
            opts.append(f"ef_construction = {int(EFC)}")
        return f"hnsw ({', '.join(opts)})"
    return f"ivf ({', '.join(opts)})"


def metric_value(cur: psycopg.Cursor, name: str, rel: str) -> int | None:
    cur.execute(f"SELECT value FROM sdb_metrics WHERE metric = %s AND relation_id = '{rel}'::regclass::BIGINT", (name,))
    row = cur.fetchone()
    return int(row[0]) if row else None


def gauge(cur: psycopg.Cursor, name: str) -> int:
    cur.execute("SELECT value FROM sdb_metrics WHERE metric = %s AND relation_id IS NULL", (name,))
    row = cur.fetchone()
    return int(row[0]) if row else 0


def sql_list(paths: list[str]) -> str:
    return "[" + ", ".join("'" + p.replace("'", "''") + "'" for p in paths) + "]"


def refresh(cur: psycopg.Cursor) -> None:
    if STORAGE == "view":
        cur.execute("VACUUM (REFRESH_INDEX) items_vec")
    else:
        cur.execute("VACUUM (REFRESH_TABLE) items")


def compact(cur: psycopg.Cursor) -> None:
    if STORAGE == "view":
        cur.execute("VACUUM (COMPACT_INDEX) items_vec")
    else:
        cur.execute("VACUUM (COMPACT_TABLE) items")


def main() -> int:
    manifest = json.loads((DSDIR / "manifest.json").read_text())
    shards = [str(DSDIR / s["path"]) for s in manifest["shards"]]
    phases: dict[str, float] = {}
    columns_ddl = (
        f"id BIGINT, cat10 SMALLINT, cat100 SMALLINT, cat1000 SMALLINT, num INTEGER, "
        f"ts TIMESTAMP, cluster SMALLINT, lang TEXT, title TEXT, emb FLOAT[{DIMS}]"
    )
    select_cols = ", ".join(COLUMNS) + f", emb::FLOAT[{DIMS}] AS emb"
    with connect() as conn:
        cur = conn.cursor()
        cur.execute(f"SET threads = {THREADS}")
        if KIND == "ivf":
            if POSTING:
                cur.execute(f"SET sdb_ivf_posting_size = {int(POSTING)}")
            if SAMPLE:
                cur.execute(f"SET sdb_ivf_sample_factor = {float(SAMPLE)}")
        t0 = time.perf_counter()
        cur.execute("DROP INDEX IF EXISTS items_vec")
        cur.execute("DROP TABLE IF EXISTS items")
        cur.execute("DROP VIEW IF EXISTS items CASCADE")
        keys = ", ".join(KEY_COLUMNS)
        if STORAGE == "search":
            cur.execute(f"CREATE TABLE items ({columns_ddl}) WITH (storage = 'search', compaction_interval = 0)")
            ddl = f"CREATE INDEX items_vec ON items USING inverted({keys}, emb {opclass()})"
        elif STORAGE == "view":
            cur.execute(f"CREATE VIEW items AS SELECT {select_cols} FROM read_parquet({sql_list(shards)})")
            ddl = (
                f"CREATE INDEX items_vec ON items USING inverted({keys}, emb {opclass()}) "
                f"INCLUDE (id) WITH (compaction_interval = 0)"
            )
        elif STORAGE == "table":
            cur.execute(f"CREATE TABLE items ({columns_ddl})")
            ddl = f"CREATE INDEX items_vec ON items USING inverted({keys}, emb {opclass()}) WITH (compaction_interval = 0)"
        else:
            log(f"ERROR: unknown VB_INDEX_STORAGE={STORAGE!r} (search | view | table)")
            return 2
        log(f"DDL: {ddl}")
        if STORAGE == "view":
            # the build is synchronous: the timer around CREATE INDEX is the whole ingest+index cost
            t1 = time.perf_counter()
            cur.execute(ddl)
            phases["index"] = time.perf_counter() - t1
        else:
            cur.execute(ddl)
            phases["ddl"] = time.perf_counter() - t0
            t1 = time.perf_counter()
            for i, shard in enumerate(shards):
                cur.execute(f"INSERT INTO items SELECT {select_cols} FROM read_parquet(%s)", (shard,))
                log(f"ingested shard {i + 1}/{len(shards)} ({time.perf_counter() - t1:.0f}s)")
            phases["ingest"] = time.perf_counter() - t1
        refresh(cur)

        t2 = time.perf_counter()
        compact(cur)
        stable = 0
        last = None
        while stable < STABLE_POLLS:
            time.sleep(POLL_S)
            refresh(cur)
            seg = metric_value(cur, "num_segments", METRIC_REL)
            busy = gauge(cur, "compaction_active") + gauge(cur, "compaction_pending")
            if seg == last and busy == 0:
                stable += 1
            else:
                stable = 0
            last = seg
            log(f"settle: segments={seg} compaction_busy={busy} stable={stable}/{STABLE_POLLS}")
        phases["compaction"] = time.perf_counter() - t2

        count_rel = "items_vec" if STORAGE == "view" else "items"
        cur.execute(f"SELECT count(*) FROM {count_rel}")
        rows = int(cur.fetchone()[0])
        if rows != manifest["rows"]:
            log(f"ERROR: {count_rel} has {rows} rows, dataset has {manifest['rows']}")
            return 1
        info = {
            "rows": rows,
            "storage": STORAGE,
            "segments": metric_value(cur, "num_segments", METRIC_REL),
            "files": metric_value(cur, "num_files", METRIC_REL),
            "index_bytes": metric_value(cur, "index_size", METRIC_REL),
            "ddl": ddl,
        }
    print("VECTORBENCH_PHASES=" + json.dumps({k: round(v, 3) for k, v in phases.items()}), flush=True)
    print("VECTORBENCH_INFO=" + json.dumps(info), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
