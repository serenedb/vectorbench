#!/bin/bash
# Full coverage pass, run after the current measurements finish so nothing overlaps.
#   1. rebuild serened without the decoded column cache
#   2. smoke the two engines that have never run, on the smallest dataset, so an integration
#      bug costs minutes instead of an hour of indexing
#   3. matched-build runs at 1m, then 100k, for every HNSW participant
#   4. IVF for coverage
# Every step records its exit status and the next one runs regardless.
set -uo pipefail
L=/home/mironov/work/.vbscratch/logs
R=/home/mironov/work/projects/serenedb/serenedb
cd /home/mironov/work/projects/serenedb/vectorbench
export PYTHONPATH=$PWD/lib VECTORBENCH_DATA_DIR=/home/mironov/work/vectorbench-data
B=$R/build_perf/bin/serened

say() { echo "$* $(date +%H:%M)" >> $L/rerun.status; }

say "=== rebuild"
ninja -C $R/build_perf serened > $L/rebuild.log 2>&1
rc=$?
say "rebuild exit $rc"
[ $rc -ne 0 ] && { tail -30 $L/rebuild.log >> $L/rerun.status; exit 1; }

# One engine at a time: Elasticsearch and OpenSearch both want port 9200.
clear_containers() {
  for c in $(docker ps -aq --filter name=vectorbench- 2>/dev/null); do
    docker rm -f "$c" >/dev/null 2>&1
  done
}

run() {  # run <participant> <dataset> [extra args...]
  local p=$1 d=$2; shift 2
  clear_containers
  if [ "$p" = serenedb-hnsw ] || [ "$p" = serenedb-ivf ]; then export VB_BINARY=$B; else unset VB_BINARY; fi
  .venv/bin/python -m vectorbench.cli run --participant "$p" --dataset "$d" --index \
    --clients 32 --query-limit 1000 --passes 1 --deadline 6 --budget 6 --min-queries 500 \
    "$@" > "$L/rerun_${p}_${d}$(printf '%s' "${LABEL:-}").log" 2>&1
  say "$p $d exit $?"
}

# 2. smoke the new engines: one unfiltered group on the smallest dataset.
LABEL=_smoke
for p in elasticsearch-hnsw opensearch-hnsw; do
  run "$p" sift-128-100k --groups 'none/10' --query-limit 200 --deadline 3 --budget 3 --min-queries 100 --label smoke
done
unset LABEL
say "=== smoke done"

# 3. the matched-build comparison, biggest value first: 1m, then 100k.
for d in sift-128-1m wiki-v3-1024-1m sift-128-100k wiki-v3-1024-100k; do
  for p in serenedb-hnsw qdrant-hnsw elasticsearch-hnsw opensearch-hnsw; do
    run "$p" "$d"
  done
  say "=== $d done"
done

# 4. IVF coverage at the sizes already prepared.
for d in sift-128-100k wiki-v3-1024-100k sift-128-1m wiki-v3-1024-1m; do
  run serenedb-ivf "$d"
done
say "=== ivf small done"

# 5. The missing size. sift at ten million is a 1.3 GB range download and a cheap ground truth;
# wiki is 40 GB and hours of exact search, so it comes last and only if sift got through.
prepare() {
  clear_containers
  .venv/bin/python -m vectorbench.cli prepare --dataset "$1" > "$L/prepare_$1.log" 2>&1
  local rc=$?
  say "prepare $1 exit $rc"
  return $rc
}

if prepare sift-128-10m; then
  for p in serenedb-hnsw qdrant-hnsw elasticsearch-hnsw opensearch-hnsw serenedb-ivf; do
    run "$p" sift-128-10m
  done
  say "=== sift-128-10m done"
fi

if prepare wiki-v3-1024-10m; then
  for p in serenedb-hnsw qdrant-hnsw elasticsearch-hnsw opensearch-hnsw serenedb-ivf; do
    run "$p" wiki-v3-1024-10m
  done
  say "=== wiki-v3-1024-10m done"
fi

clear_containers
say RERUN_DONE
