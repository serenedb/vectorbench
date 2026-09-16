#!/usr/bin/env bash
set -euo pipefail
export ENGINE_NAME="Elasticsearch HNSW"
export ENGINE_TAGS='["Java", "Lucene", "Elasticsearch"]'
exec "$(dirname "$0")/../lib/benchmark.sh" "$@"
