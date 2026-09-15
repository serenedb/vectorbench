#!/usr/bin/env bash
# VectorBench shared entry. A participant's ./benchmark.sh exec's this from its own directory, so
#   cd serenedb-ivf && VECTORBENCH_DATA_DIR=/data VECTORBENCH_DATASET=sift-128-100k ./benchmark.sh --index
# reads like SearchBench. Everything else is `vectorbench run` (see `vectorbench run --help`).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
py="$root/.venv/bin/python"
[[ -x "$py" ]] || py="$(command -v python3)"

: "${VECTORBENCH_DATA_DIR:?VECTORBENCH_DATA_DIR must point at the prepared-data root}"
: "${VECTORBENCH_DATASET:?VECTORBENCH_DATASET must be <family>-<size>, e.g. sift-128-100k}"

export PYTHONPATH="$root/lib${PYTHONPATH:+:$PYTHONPATH}"
exec "$py" -m vectorbench.cli run --participant "$(pwd)" --dataset "$VECTORBENCH_DATASET" "$@"
