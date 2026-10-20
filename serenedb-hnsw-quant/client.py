"""SereneDB client for VectorBench (docs/contracts.md section 7): psycopg 3, binary protocol.

The distance operator written in queries.sql (`<#>`) is rewritten to the family's metric (`<#>` ip,
`<->` l2) from cfg["metric"], which the driver adds to the connection settings, so one file serves both."""

from __future__ import annotations

import os
import re
import struct
from typing import Any

import numpy as np
import psycopg
from psycopg.types.array import ListBinaryDumper
from psycopg.types.numeric import Float4BinaryDumper
from psycopg.adapt import Dumper
from psycopg.pq import Format as PqFormat


class NdarrayFloat4BinaryDumper(Dumper):
    """A numpy vector as a FLOAT4[] in Postgres binary form.

    psycopg's generic list dumper boxes every element -- 134us for a 1024-float
    vector against 0.6us here -- and `tolist()` yields Python floats, so it
    sends float8: twelve bytes a dimension on the wire plus a cast the server
    then has to undo. The driver times the client call, so that lands in every
    latency and every qps this participant reports, against a competitor whose
    client serialises in C. Encoding the array with numpy measures the engine
    instead of psycopg.
    """

    format = PqFormat.BINARY
    oid = 1021  # float4[]
    _HEADER = struct.Struct("!iiiii")  # ndim, hasnull, elem oid, dim, lower bound

    def dump(self, obj: "np.ndarray") -> bytes:
        a = np.ascontiguousarray(obj, dtype=">f4")
        n = a.shape[0]
        # Postgres writes a 4-byte length before every element; build both
        # columns at once so the whole payload is one vectorised store.
        out = np.empty((n, 2), dtype=">u4")
        out[:, 0] = 4
        out[:, 1] = a.view(">u4")
        return self._HEADER.pack(1, 0, 700, n, 1) + out.tobytes()

OPERATORS = {"ip": "<#>", "l2": "<->", "cosine": "<=>"}
PARAM_RE = re.compile(r"\$(qd|q|k|v|lo|hi|v2|s)\b")


class Client:
    def __init__(self, cfg: dict[str, Any]):
        self.cfg = cfg
        self.conn: psycopg.Connection | None = None
        self.metric = str(cfg.get("metric") or os.environ.get("VECTORBENCH_METRIC", "ip"))
        self.dims = int(cfg.get("dims") or os.environ.get("VECTORBENCH_DIMS", "0") or 0)

    def connect(self) -> None:
        self.conn = psycopg.connect(
            host=self.cfg.get("host", "127.0.0.1"),
            port=int(self.cfg.get("port", 5499)),
            user=self.cfg.get("user", "postgres"),
            dbname=self.cfg.get("dbname", "postgres"),
            autocommit=True,
            prepare_threshold=0,
        )
        # The query vector travels as a binary float4 array, not as text: the server then reads
        # dims floats instead of parsing dims decimal strings (about 0.1 ms per query at 128 dims).
        self.conn.adapters.register_dumper(float, Float4BinaryDumper)
        self.conn.adapters.register_dumper(list, ListBinaryDumper)
        self.conn.adapters.register_dumper(np.ndarray, NdarrayFloat4BinaryDumper)

    def prepare_group(self, block: str) -> Any:
        assert self.conn is not None
        stmts = [s.strip() for s in block.split(";") if s.strip()]
        setup, query = stmts[:-1], stmts[-1]
        op = OPERATORS[self.metric]
        query = query.replace("<#>", op).replace("<->", op)
        for s in setup:
            self.conn.execute(s)
        # named placeholders -> positional %s with a recorded order; $q gets a typed cast
        order: list[str] = []

        def repl(m: re.Match[str]) -> str:
            name = m.group(1)
            order.append(name)
            if name == "q":
                return f"%s::FLOAT[{self.dims}]" if self.dims else "%s"
            if name == "qd":  # brute-force form: DOUBLE arrays keep the ANN pushdown out of the plan
                return f"%s::DOUBLE[{self.dims}]"
            return "%s"

        sql = PARAM_RE.sub(repl, query)
        return {"sql": sql, "order": order}

    def search(self, handle: Any, vec: np.ndarray, k: int, args: dict[str, Any]) -> list[int]:
        assert self.conn is not None
        vals: list[Any] = []
        for name in handle["order"]:
            if name == "q":
                vals.append(vec)
            elif name == "qd":
                vals.append(vec.tolist())
            elif name == "k":
                vals.append(int(k))
            else:
                vals.append(args[name])
        cur = self.conn.execute(handle["sql"], vals, binary=True)
        return [int(r[0]) for r in cur.fetchall()]

    def explain(self, handle: Any, vec: np.ndarray, k: int, args: dict[str, Any]) -> str:
        """EXPLAIN of the per-query statement with real parameters; the driver checks it for IRESEARCH_SCAN."""
        assert self.conn is not None
        vals: list[Any] = []
        for name in handle["order"]:
            vals.append(vec if name == "q" else vec.tolist() if name == "qd" else int(k) if name == "k" else args[name])
        cur = self.conn.execute("EXPLAIN " + handle["sql"], vals, binary=True)
        return "\n".join(str(r[-1]) for r in cur.fetchall())

    def close(self) -> None:
        if self.conn is not None:
            self.conn.close()
            self.conn = None
