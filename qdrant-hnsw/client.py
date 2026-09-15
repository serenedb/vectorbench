"""VectorBench client for the Qdrant HNSW participant (docs/contracts.md section 7).

A block is one value of queries.json with the ladder knobs already substituted by the driver:
{"filter": <Qdrant REST filter with "$v" "$lo" "$hi" "$v2" "$s" placeholders> | null,
 "params": {"hnsw_ef": <int>, "exact": <bool>, "quantization": {"rescore": .., "oversampling": ..}}}.
Searches use qdrant-client's gRPC stub (Points/Query) directly: `query_points` converts every returned
point into a REST model, which costs 5.6 ms per query at k=1000, twice the search itself."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import numpy as np
from qdrant_client import QdrantClient
from qdrant_client import grpc as q


@dataclass(frozen=True)
class Handle:
    filter: dict[str, Any] | None  # REST-dialect filter template, placeholders left in
    params: q.SearchParams


def _arg(value: Any, args: dict[str, Any]) -> Any:
    """A "$name" placeholder becomes the query's argument; anything else passes through."""
    return args[value[1:]] if isinstance(value, str) and value.startswith("$") else value


def _condition(cond: dict[str, Any], args: dict[str, Any]) -> q.Condition:
    fc = q.FieldCondition(key=cond["key"])
    if "match" in cond:
        v = _arg(cond["match"]["value"], args)
        fc.match.CopyFrom(q.Match(keyword=v) if isinstance(v, str) else q.Match(integer=int(v)))
    if "range" in cond:
        fc.range.CopyFrom(q.Range(**{bound: float(_arg(x, args)) for bound, x in cond["range"].items()}))
    return q.Condition(field=fc)


def _filter(template: dict[str, Any], args: dict[str, Any]) -> q.Filter:
    return q.Filter(**{clause: [_condition(c, args) for c in conds] for clause, conds in template.items()})


class Client:
    def __init__(self, cfg: dict[str, Any]):
        self.cfg = cfg
        self.collection: str = str(cfg.get("collection", "items"))
        self.timeout = int(cfg.get("timeout", 600))
        self.client: QdrantClient | None = None
        self.points: q.PointsStub | None = None

    def connect(self) -> None:
        self.client = QdrantClient(
            host=str(self.cfg.get("host", "127.0.0.1")), port=int(self.cfg.get("port", 6333)),
            grpc_port=int(self.cfg.get("grpc_port", 6334)), prefer_grpc=True, timeout=self.timeout,
            check_compatibility=False,
        )
        self.points = self.client.grpc_points

    def prepare_group(self, block: str) -> Handle:
        b = json.loads(block)
        p = b.get("params") or {}
        params = q.SearchParams()
        if p.get("hnsw_ef") is not None:
            params.hnsw_ef = int(p["hnsw_ef"])
        if str(p.get("exact", False)).lower() == "true":
            params.exact = True
        if p.get("quantization"):
            qp = {k: float(v) if k == "oversampling" else str(v).lower() == "true" for k, v in p["quantization"].items()}
            params.quantization.CopyFrom(q.QuantizationSearchParams(**qp))
        return Handle(b.get("filter"), params)

    def search(self, handle: Handle, vec: np.ndarray, k: int, args: dict[str, Any]) -> list[int]:
        assert self.points is not None, "connect() first"
        req = q.QueryPoints(
            collection_name=self.collection,
            query=q.Query(nearest=q.VectorInput(dense=q.DenseVector(data=vec.tolist()))),
            limit=k, params=handle.params,
            with_payload=q.WithPayloadSelector(enable=False), with_vectors=q.WithVectorsSelector(enable=False),
        )
        if handle.filter is not None:
            req.filter.CopyFrom(_filter(handle.filter, args))
        return [p.id.num for p in self.points.Query(req, timeout=self.timeout).result]

    def close(self) -> None:
        if self.client is not None:
            self.client.close()
            self.client = self.points = None
