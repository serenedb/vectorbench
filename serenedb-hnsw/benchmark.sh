#!/usr/bin/env bash
# SereneDB HNSW participant entry. Scripts are shared with serenedb-ivf through symlinks.
set -euo pipefail
cd "$(dirname "$0")"
export ENGINE_NAME="SereneDB HNSW"
export ENGINE_TAGS='["C++","SereneDB","Postgres-wire"]'
exec ../lib/benchmark.sh "$@"
