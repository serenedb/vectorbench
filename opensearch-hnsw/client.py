"""VectorBench client for the OpenSearch HNSW participant (docs/contracts.md section 7).

A block is one value of queries.json with the ladder knobs already substituted:
{"filter": <OpenSearch query object with "$v" "$lo" "$hi" "$s" placeholders> | null,
 "ef_search": <int>, "exact": <bool, optional>}.

Requests go over a kept-alive http.client connection rather than the opensearch-py client: the hot
path is one search per query and the official client costs more per call than the search does at
k=10. `_source` is off and the dataset id is the document `_id`, so a hit is two small strings."""

from __future__ import annotations

import http.client
import json
from dataclasses import dataclass
from typing import Any

import numpy as np


@dataclass(frozen=True)
class Handle:
    filter: dict[str, Any] | None  # OpenSearch query object, placeholders left in
    ef_search: int | None
    exact: bool


def _arg(value: Any, args: dict[str, Any]) -> Any:
    """A "$name" placeholder becomes the query's argument; anything else passes through."""
    if isinstance(value, str) and value.startswith("$"):
        v = args[value[1:]]
        return v.item() if isinstance(v, np.generic) else v
    if isinstance(value, dict):
        return {k: _arg(x, args) for k, x in value.items()}
    if isinstance(value, list):
        return [_arg(x, args) for x in value]
    return value


class Client:
    def __init__(self, cfg: dict[str, Any]):
        self.cfg = cfg
        self.index: str = str(cfg.get("index_name", "items"))
        self.host = str(cfg.get("host", "127.0.0.1"))
        self.port = int(cfg.get("port", 9200))
        self.timeout = int(cfg.get("timeout", 600))
        self.space = str(cfg.get("exact_space", "l2"))
        self.conn: http.client.HTTPConnection | None = None

    def connect(self) -> None:
        self.conn = http.client.HTTPConnection(self.host, self.port, timeout=self.timeout)
        self.conn.connect()

    def prepare_group(self, block: str) -> Handle:
        b = json.loads(block)
        ef = b.get("ef_search")
        return Handle(
            filter=b.get("filter"),
            ef_search=int(ef) if ef is not None else None,
            exact=str(b.get("exact", False)).lower() == "true",
        )

    def _body(self, handle: Handle, vec: np.ndarray, k: int, args: dict[str, Any]) -> dict[str, Any]:
        query = vec.tolist()
        flt = _arg(handle.filter, args) if handle.filter is not None else None
        if handle.exact:
            # Brute force over every vector the filter admits: the plugin's knn_score script, which
            # is what OpenSearch documents as exact k-NN.
            inner: dict[str, Any] = flt if flt is not None else {"match_all": {}}
            return {
                "size": k, "_source": False, "track_total_hits": False,
                "query": {"script_score": {
                    "query": inner,
                    "script": {"source": "knn_score", "lang": "knn",
                               "params": {"field": "emb", "query_value": query,
                                          "space_type": self.space}},
                }},
            }
        knn: dict[str, Any] = {"vector": query, "k": k}
        if handle.ef_search is not None:
            # Per-query beam: the plugin floors it at k, and setting it here keeps the index
            # setting out of the measured path.
            knn["method_parameters"] = {"ef_search": max(handle.ef_search, k)}
        if flt is not None:
            knn["filter"] = flt
        return {"size": k, "_source": False, "track_total_hits": False,
                "query": {"knn": {"emb": knn}}}

    def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        assert self.conn is not None, "connect() first"
        payload = json.dumps(body).encode()
        headers = {"Content-Type": "application/json", "Content-Length": str(len(payload))}
        try:
            self.conn.request("POST", path, payload, headers)
            resp = self.conn.getresponse()
            data = resp.read()
        except (http.client.HTTPException, OSError):
            # A kept-alive connection the server closed: reconnect once and retry.
            self.connect()
            self.conn.request("POST", path, payload, headers)
            resp = self.conn.getresponse()
            data = resp.read()
        if resp.status != 200:
            raise RuntimeError(f"opensearch {resp.status}: {data[:400].decode(errors='replace')}")
        return json.loads(data)

    def search(self, handle: Handle, vec: np.ndarray, k: int, args: dict[str, Any]) -> list[int]:
        out = self._post(f"/{self.index}/_search", self._body(handle, vec, k, args))
        return [int(hit["_id"]) for hit in out["hits"]["hits"]]

    def explain(self, handle: Handle, vec: np.ndarray, k: int, args: dict[str, Any]) -> str:
        body = self._body(handle, vec, k, args) | {"profile": True}
        out = self._post(f"/{self.index}/_search", body)
        kinds: list[str] = []

        def collect(nodes: Any) -> None:
            if isinstance(nodes, list):
                for n in nodes:
                    collect(n)
            elif isinstance(nodes, dict):
                if "type" in nodes:
                    kinds.append(str(nodes["type"]))
                collect(nodes.get("children"))

        for shard in out.get("profile", {}).get("shards", []):
            for search in shard.get("searches", []):
                collect(search.get("query"))
        return json.dumps({"query_types": sorted(set(kinds))})

    def close(self) -> None:
        if self.conn is not None:
            self.conn.close()
            self.conn = None
