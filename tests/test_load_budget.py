"""The load budget has to be enforced while the recipe is still talking.

`proc.wait(timeout=...)` cannot do it: the output is drained first, so a recipe that hangs, or one
that keeps printing progress forever, never reaches the wait. These check that the watchdog stops
it, that the whole process tree goes down, and that a recipe finishing inside its budget is
untouched.
"""

from __future__ import annotations

import os
import textwrap
import time

import pytest
import yaml

from vectorbench.engine import LoadTimeout, Participant


def make_participant(tmp_path, load_body: str) -> Participant:
    d = tmp_path / "fake-engine"
    d.mkdir()
    (d / "settings.yml").write_text(yaml.safe_dump({
        "participant": {"name": "Fake", "system": "Fake", "family": "hnsw"},
        "connection": {"host": "127.0.0.1"},
        "defaults": {"index": {}, "ladder": {}},
    }))
    from vectorbench.engine import SCRIPTS

    for name in SCRIPTS:
        f = d / name
        f.write_text("#!/usr/bin/env bash\n" + (textwrap.dedent(load_body) if name == "load" else "exit 0\n"))
        f.chmod(0o755)
    return Participant(d)


def test_budget_stops_a_recipe_that_keeps_talking(tmp_path):
    p = make_participant(tmp_path, """
        while true; do echo "still indexing"; sleep 0.05; done
    """)
    t0 = time.perf_counter()
    with pytest.raises(LoadTimeout) as excinfo:
        p.load({**os.environ, "VECTORBENCH_DATASET": "fake-1m"}, timeout=1.0)
    elapsed = time.perf_counter() - t0
    assert elapsed < 10.0, "the watchdog did not fire while output was still arriving"
    assert excinfo.value.budget == 1.0
    assert "still indexing" in excinfo.value.tail


def test_budget_stops_a_recipe_that_says_nothing(tmp_path):
    p = make_participant(tmp_path, """
        sleep 300
    """)
    t0 = time.perf_counter()
    with pytest.raises(LoadTimeout):
        p.load({**os.environ}, timeout=1.0)
    assert time.perf_counter() - t0 < 10.0


def test_budget_takes_down_the_whole_tree(tmp_path):
    marker = tmp_path / "child-was-alive"
    p = make_participant(tmp_path, f"""
        ( sleep 5; touch {marker} ) &
        sleep 300
    """)
    with pytest.raises(LoadTimeout):
        p.load({**os.environ}, timeout=1.0)
    time.sleep(6)
    assert not marker.exists(), "a grandchild of the load recipe outlived the budget"


def test_a_recipe_inside_its_budget_is_untouched(tmp_path):
    p = make_participant(tmp_path, """
        echo 'VECTORBENCH_PHASES={"ingest": 1.5}'
        echo 'VECTORBENCH_INFO={"segments": 3}'
    """)
    r = p.load({**os.environ}, timeout=30.0)
    assert r.phases == {"ingest": 1.5}
    assert r.info == {"segments": 3}


def test_no_budget_means_no_watchdog(tmp_path):
    p = make_participant(tmp_path, """
        echo 'VECTORBENCH_PHASES={"ingest": 0.1}'
    """)
    assert p.load({**os.environ}).phases == {"ingest": 0.1}
