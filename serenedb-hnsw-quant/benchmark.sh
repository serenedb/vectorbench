#!/usr/bin/env bash
# SereneDB HNSW participant entry: set the engine identity and hand off to ../lib/benchmark.sh.
set -euo pipefail
cd "$(dirname "$0")"
export ENGINE_NAME="SereneDB HNSW"
export ENGINE_TAGS='["C++","SereneDB","Postgres-wire"]'
exec ../lib/benchmark.sh "$@"
