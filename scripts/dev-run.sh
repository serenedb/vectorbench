#!/usr/bin/env bash
# Development runs: every listed participant on every listed dataset size with reduced budgets, then
# assemble results and build the page. Numbers are for checking that everything works and looks sane,
# not for publication (see DESIGN.md section 4 for the published budgets).
#
#   scripts/dev-run.sh [participants...]        default: serenedb-ivf serenedb-hnsw qdrant-hnsw
#   DATASETS="sift-128-100k wiki-v3-1024-100k"  space-separated (default both 100k slices)
#   VB_BINARY=/path/to/serened                  native SereneDB binary instead of the docker image
#   VECTORBENCH_DATA_DIR=...                    prepared data root (required)
#   CLIENTS=32 QUERY_LIMIT=2000 PASSES=1 DEADLINE=8 BUDGET=8 MIN_QUERIES=1000
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
: "${VECTORBENCH_DATA_DIR:?set VECTORBENCH_DATA_DIR}"
: "${DATASETS:=sift-128-100k wiki-v3-1024-100k}"
: "${CLIENTS:=32}" "${QUERY_LIMIT:=2000}" "${PASSES:=1}" "${DEADLINE:=8}" "${BUDGET:=8}" "${MIN_QUERIES:=1000}"
participants=("$@")
[[ ${#participants[@]} -gt 0 ]] || participants=(serenedb-ivf serenedb-hnsw qdrant-hnsw)
export PYTHONPATH="$root/lib" PATH="$HOME/.local/bin:$PATH"
py="$root/.venv/bin/python"
log_dir="$root/.dev-run-logs"; mkdir -p "$log_dir"

for ds in $DATASETS; do
    for p in "${participants[@]}"; do
        log="$log_dir/${p}_${ds}.log"
        echo "=== $(date +%H:%M:%S) $p on $ds (log: $log)"
        if ! "$py" -m vectorbench.cli run --participant "$p" --dataset "$ds" --index \
                --clients "$CLIENTS" --query-limit "$QUERY_LIMIT" --passes "$PASSES" \
                --deadline "$DEADLINE" --budget "$BUDGET" --min-queries "$MIN_QUERIES" > "$log" 2>&1; then
            echo "    FAILED (see $log)"; tail -5 "$log"
        else
            echo "    ok: $(grep -c 'recall=' "$log") points, $(grep -c 'ERROR' "$log") group errors"
        fi
    done
done

echo "=== $(date +%H:%M:%S) assemble + build page"
"$py" -m vectorbench.cli assemble
(cd frontend && npm run build > "$log_dir/frontend-build.log" 2>&1 && echo "    frontend/index.html built") || { echo "    frontend build FAILED"; tail -20 "$log_dir/frontend-build.log"; }
