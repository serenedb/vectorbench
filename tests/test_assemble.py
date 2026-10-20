"""`assemble --dataset`: the page gets the chosen datasets and their families, nothing else."""

from __future__ import annotations

import pytest

from vectorbench.assemble import only_datasets

FAMILIES = {"sift-128": {"family": "sift-128"}, "wiki-v3-1024": {"family": "wiki-v3-1024"}}
RESULTS = [
    {"participant": "serenedb-hnsw", "dataset": "sift-128-1m"},
    {"participant": "serenedb-hnsw", "dataset": "wiki-v3-1024-1m"},
    {"participant": "serenedb-hnsw-quant", "dataset": "wiki-v3-1024-50m"},
    {"participant": "qdrant-hnsw-quant", "dataset": "wiki-v3-1024-50m"},
]


def test_only_the_chosen_dataset_and_its_family():
    fams, results = only_datasets(FAMILIES, RESULTS, ["wiki-v3-1024-50m"])
    assert list(fams) == ["wiki-v3-1024"]
    assert [r["participant"] for r in results] == ["serenedb-hnsw-quant", "qdrant-hnsw-quant"]


def test_two_datasets_of_two_families():
    fams, results = only_datasets(FAMILIES, RESULTS, ["sift-128-1m", "wiki-v3-1024-50m"])
    assert sorted(fams) == ["sift-128", "wiki-v3-1024"]
    assert len(results) == 3


def test_a_dataset_nobody_ran_is_an_error():
    with pytest.raises(ValueError, match="sift-128-50m"):
        only_datasets(FAMILIES, RESULTS, ["sift-128-50m"])
