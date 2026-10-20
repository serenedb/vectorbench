#!/usr/bin/env bash
# Qdrant HNSW entrypoint: set the engine identity, hand off to ../lib/benchmark.sh from this directory
# so the adapter scripts (./install, ./start, ...) resolve engine-local.
set -e

export ENGINE_NAME="Qdrant HNSW"
export ENGINE_TAGS='["Rust","Qdrant"]'

cd "$(dirname "$0")"
exec ../lib/benchmark.sh "$@"
