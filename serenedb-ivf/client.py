"""SereneDB client for VectorBench (docs/contracts.md section 7): psycopg 3, binary protocol.

The distance operator written in queries.sql (`<#>`) is rewritten to the family's metric (`<#>` ip,
`<->` l2) from cfg["metric"], which the driver adds to the connection settings, so one file serves both."""

from __future__ import annotations

import os
import re
from typing import Any

import numpy as np
import psycopg

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
            if name in ("q", "qd"):
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
            vals.append(vec.tolist() if name in ("q", "qd") else int(k) if name == "k" else args[name])
        cur = self.conn.execute("EXPLAIN " + handle["sql"], vals, binary=True)
        return "\n".join(str(r[-1]) for r in cur.fetchall())

    def close(self) -> None:
        if self.conn is not None:
            self.conn.close()
            self.conn = None
