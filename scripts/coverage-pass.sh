#!/bin/bash
# The corrected coverage pass. Everything measured before it used at least one of:
#   - a serened without the sampled column-predicate bound, so range rows always walked
#   - a SereneDB ladder with no bridge mode at k=10
#   - Elasticsearch and OpenSearch scoring exact rows in the wrong metric
#   - no settle after the per-group restart, so a JVM was measured partly interpreted
# so every participant is re-measured, not only the ones whose own code changed.
set -uo pipefail
L=/home/mironov/work/.vbscratch/logs
R=/home/mironov/work/projects/serenedb/serenedb
cd /home/mironov/work/projects/serenedb/vectorbench
export PYTHONPATH=$PWD/lib VECTORBENCH_DATA_DIR=/home/mironov/work/vectorbench-data
B=$R/build_perf/bin/serened

say() { echo "$* $(date +%H:%M)" >> $L/pass2.status; }
clear_containers() {
  for c in $(docker ps -aq --filter name=vectorbench- 2>/dev/null); do docker rm -f "$c" >/dev/null 2>&1; done
}

say "=== rebuild"
ninja -C $R/build_perf serened > $L/rebuild2.log 2>&1
rc=$?
say "rebuild exit $rc"
[ $rc -ne 0 ] && { tail -30 $L/rebuild2.log >> $L/pass2.status; exit 1; }

run() {  # run <participant> <dataset>
  clear_containers
  if [ "$1" = serenedb-hnsw ] || [ "$1" = serenedb-ivf ]; then export VB_BINARY=$B; else unset VB_BINARY; fi
  .venv/bin/python -m vectorbench.cli run --participant "$1" --dataset "$2" --index \
    --clients 32 --query-limit 1000 --passes 1 --deadline 6 --budget 6 --min-queries 500 \
    --load-timeout 7200 > "$L/p2_$1_$2.log" 2>&1
  say "$1 $2 exit $?"
}

HNSW="serenedb-hnsw qdrant-hnsw elasticsearch-hnsw opensearch-hnsw"

for d in sift-128-1m wiki-v3-1024-1m sift-128-100k wiki-v3-1024-100k; do
  for p in $HNSW; do run "$p" "$d"; done
  say "=== $d hnsw done"
done

for d in sift-128-100k wiki-v3-1024-100k sift-128-1m wiki-v3-1024-1m; do
  run serenedb-ivf "$d"
done
say "=== ivf small done"

prepare() {
  clear_containers
  .venv/bin/python -m vectorbench.cli prepare --dataset "$1" > "$L/prepare_$1.log" 2>&1
  local rc=$?
  say "prepare $1 exit $rc"
  return $rc
}

# Ten million, unfiltered first. The full row set there is about fifteen hours of measurement across
# five participants and two families, and the unfiltered rows are both the headline and a tenth of
# the work, so they land first and the filtered rows follow. A run without --index reuses the index
# the unfiltered pass built, so the second phase pays no load time.
UNFILTERED='none/10,none/100,none/1000,exact/none/10'

run_groups() {  # run_groups <participant> <dataset> <groups> [--index]
  clear_containers
  if [ "$1" = serenedb-hnsw ] || [ "$1" = serenedb-ivf ]; then export VB_BINARY=$B; else unset VB_BINARY; fi
  local tag=$4
  .venv/bin/python -m vectorbench.cli run --participant "$1" --dataset "$2" ${4:+--index} \
    --groups "$3" --clients 32 --query-limit 1000 --passes 1 --deadline 6 --budget 6 \
    --min-queries 500 --load-timeout 7200 > "$L/p2_$1_$2${tag:+_idx}.log" 2>&1
  say "$1 $2 groups=${3%%,*}... exit $?"
}

for d in sift-128-10m wiki-v3-1024-10m; do
  prepare "$d" || continue
  for p in $HNSW serenedb-ivf; do run_groups "$p" "$d" "$UNFILTERED" index; done
  say "=== $d unfiltered done"
done
for d in sift-128-10m wiki-v3-1024-10m; do
  [ -d "$VECTORBENCH_DATA_DIR/$d" ] || continue
  for p in $HNSW serenedb-ivf; do run_groups "$p" "$d" 'eq-10/*,eq-1/*,eq-0.1/*,range-10/*,range-1/*,and-1/*,corr/*,xcorr/*,lang/*,xlang/*,exact/eq-1/10'; done
  say "=== $d filtered done"
done

clear_containers
say PASS2_DONE
