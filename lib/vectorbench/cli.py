"""Command line: prepare, run, trace, check, assemble."""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

from .families import load_family, split_dataset_id


def _data_dir(args: argparse.Namespace) -> Path:
    d = getattr(args, "data_dir", None) or os.environ.get("VECTORBENCH_DATA_DIR")
    if not d:
        raise SystemExit("set --data-dir or VECTORBENCH_DATA_DIR")
    return Path(d).expanduser().resolve()


def cmd_prepare(args: argparse.Namespace) -> int:
    from .prepare import Preparer

    family_name, size = split_dataset_id(args.dataset)
    fam = load_family(family_name)
    m = Preparer(fam, size, _data_dir(args)).run()
    print(json.dumps({k: m[k] for k in ("dataset", "rows", "nq", "dims", "metric", "norms", "groundtruth")}, indent=1))
    return 0


def _participant(args: argparse.Namespace):
    from .engine import Participant

    p = Participant(Path(args.participant or os.getcwd()))
    overrides = {}
    for item in getattr(args, "index_set", []) or []:
        if "=" not in item:
            raise SystemExit(f"--index-set expects KEY=VALUE, got {item!r}")
        k, v = item.split("=", 1)
        overrides[k.strip()] = _num(v.strip())
    if overrides:
        p.settings.setdefault("defaults", {}).setdefault("index", {})
        # apply on top of every dataset size too, since size blocks override defaults
        p.settings["defaults"]["index"].update(overrides)
        for fam in (p.settings.get("datasets") or {}).values():
            for size in (fam or {}).values():
                if isinstance(size, dict) and size.get("index"):
                    size["index"].update(overrides)
    return p


def cmd_run(args: argparse.Namespace) -> int:
    from .runner import RunOptions, Runner

    family_name, size = split_dataset_id(args.dataset)
    fam = load_family(family_name)
    p = _participant(args)
    opts = RunOptions(
        data_dir=_data_dir(args),
        views=args.views.split(","),
        groups=args.groups.split(",") if args.groups else None,
        cpuset=args.cpuset or None,
        memory=args.memory or None,
        tier_cpus=args.clients,
        index=args.index,
        label=args.label,
        warmup=args.warmup,
        passes=args.passes,
        deadline_s=args.deadline,
        min_queries=args.min_queries,
        total_budget_s=args.budget,
        query_limit=args.query_limit,
        dry_run=args.dry_run,
    )
    r = Runner(p, fam, size, opts)
    if args.dry_run:
        for row in r.plan():
            print(json.dumps(row))
        return 0
    r.run()
    return 0


def cmd_trace(args: argparse.Namespace) -> int:
    from .runner import RunOptions, Runner

    family_name, size = split_dataset_id(args.dataset)
    fam = load_family(family_name)
    p = _participant(args)
    ladder = {}
    for item in args.knob:
        name, values = item.split("=", 1)
        ladder[name] = [_num(v) for v in values.split(",")]
    opts = RunOptions(data_dir=_data_dir(args), views=["latency"], groups=[args.group], cpuset=args.cpuset or None,
                      memory=args.memory or None, tier_cpus=1, index=False, label="trace", warmup=20, passes=1,
                      deadline_s=args.deadline, min_queries=min(args.queries, 100000), total_budget_s=args.deadline,
                      query_limit=args.queries)
    r = Runner(p, fam, size, opts)
    # override the ladder for the traced group
    ds = r.p.settings.setdefault("datasets", {}).setdefault(fam.name, {}).setdefault(size, {})
    ds.setdefault("groups", {})[args.group] = {"ladder": ladder}
    (p.dir / "trace").mkdir(exist_ok=True)
    r.p.results_dir = lambda: p.dir / "trace"  # type: ignore[method-assign]
    path = r.run()
    obj = json.loads(path.read_text())
    for g in obj["groups"]:
        print(f"# {g['key']} {g.get('status')}")
        for pt in g.get("points", []):
            lat = pt["latency_ms"]
            print(f"{pt['knobs']}\trecall={pt['recall']:.4f}\tqps={pt['qps']:.1f}\tp50={lat['p50']:.2f}ms\tp99={lat['p99']:.2f}ms")
    return 0


def _num(s: str):
    try:
        return int(s)
    except ValueError:
        try:
            return float(s)
        except ValueError:
            return s


def cmd_check(args: argparse.Namespace) -> int:
    from .check import run_check

    family_name, size = split_dataset_id(args.dataset)
    fam = load_family(family_name)
    return run_check(_participant(args), fam, size, _data_dir(args), queries=args.queries, cpuset=args.cpuset or None, memory=args.memory or None)


def cmd_targets(args: argparse.Namespace) -> int:
    from .targets import run as run_targets

    for dataset in args.dataset.split(","):
        print(run_targets(dataset.strip(), view=args.view, metric=args.metric), end="")
    return 0


def cmd_assemble(args: argparse.Namespace) -> int:
    from .assemble import assemble

    assemble(out_path=Path(args.out) if args.out else None)
    return 0


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="vectorbench", description="VectorBench driver")
    ap.add_argument("-v", "--verbose", action="store_true")
    sub = ap.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("prepare", help="materialize a dataset size (download, attributes, ground truth)")
    s.add_argument("--dataset", required=True, help="<family>-<size>, e.g. sift-128-100k")
    s.add_argument("--data-dir")
    s.set_defaults(fn=cmd_prepare)

    def common(s: argparse.ArgumentParser) -> None:
        s.add_argument("--dataset", default=os.environ.get("VECTORBENCH_DATASET"), required=not os.environ.get("VECTORBENCH_DATASET"))
        s.add_argument("--data-dir")
        s.add_argument("--participant", help="participant directory (default: current directory)")
        s.add_argument("--cpuset", default=os.environ.get("VECTORBENCH_CPUSET", ""))
        s.add_argument("--memory", default=os.environ.get("VECTORBENCH_MEMORY", ""))
        s.add_argument("--index-set", action="append", default=[], metavar="KEY=VALUE",
                       help="override a key of the resolved index block (e.g. storage=view relation=items_vec); recorded in the result")

    s = sub.add_parser("run", help="run every group of a participant on a dataset size")
    common(s)
    s.add_argument("--index", action="store_true", help="install, start and load before running")
    s.add_argument("--views", default="throughput,latency")
    s.add_argument("--groups", help="comma-separated group keys or <filter>/* patterns")
    s.add_argument("--clients", type=int, default=32, help="clients in the throughput view (the tier's CPU count)")
    s.add_argument("--label", help="results suffix for side-by-side builds of one participant")
    s.add_argument("--warmup", type=int, default=100)
    s.add_argument("--passes", type=int, default=3)
    s.add_argument("--deadline", type=float, default=60.0, help="seconds per pass")
    s.add_argument("--min-queries", type=int, default=2000)
    s.add_argument("--budget", type=float, default=60.0, help="seconds per point across passes")
    s.add_argument("--query-limit", type=int, help="use only the first N queries (development)")
    s.add_argument("--dry-run", action="store_true")
    s.set_defaults(fn=cmd_run)

    s = sub.add_parser("trace", help="quick recall/QPS trace of a knob ladder at 1 client")
    common(s)
    s.add_argument("--group", required=True, help="group key, e.g. eq-1/10")
    s.add_argument("--knob", action="append", required=True, help="name=v1,v2,...; repeatable")
    s.add_argument("--queries", type=int, default=1000)
    s.add_argument("--deadline", type=float, default=20.0)
    s.set_defaults(fn=cmd_trace)

    s = sub.add_parser("check", help="predicate, k-count and exact-recall checks on a small dataset")
    common(s)
    s.add_argument("--queries", type=int, default=200)
    s.set_defaults(fn=cmd_check)

    s = sub.add_parser("targets", help="propose a recall target per row from the measured frontiers")
    s.add_argument("--dataset", required=True, help="dataset id, or several separated by commas")
    s.add_argument("--view", default="throughput", choices=["throughput", "latency"])
    s.add_argument("--metric", default="qps", help="qps, p50, p90, p95 or p99")
    s.set_defaults(fn=cmd_targets)

    s = sub.add_parser("assemble", help="build frontend/results.json from every result file")
    s.add_argument("--out")
    s.set_defaults(fn=cmd_assemble)
    return ap


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S", stream=sys.stderr)
    return int(args.fn(args) or 0)


if __name__ == "__main__":
    sys.exit(main())
