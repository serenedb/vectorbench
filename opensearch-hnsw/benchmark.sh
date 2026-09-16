#!/usr/bin/env bash
set -euo pipefail
export ENGINE_NAME="OpenSearch HNSW"
export ENGINE_TAGS='["Java", "Lucene", "OpenSearch"]'
exec "$(dirname "$0")/../lib/benchmark.sh" "$@"
