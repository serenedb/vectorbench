#!/usr/bin/env bash
# SereneDB IVF participant entry. `cd serenedb-ivf && VECTORBENCH_DATA_DIR=... VECTORBENCH_DATASET=... ./benchmark.sh --index`
set -euo pipefail
cd "$(dirname "$0")"
export ENGINE_NAME="SereneDB IVF"
export ENGINE_TAGS='["C++","SereneDB","Postgres-wire"]'
exec ../lib/benchmark.sh "$@"
