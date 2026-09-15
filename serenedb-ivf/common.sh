# Shared by the SereneDB participant scripts. Sourced, not executed.
# Environment comes from the driver (docs/contracts.md section 4); defaults keep the scripts usable by hand.
: "${VB_PORT:=5499}"
: "${VB_CONTAINER:=vectorbench-serenedb}"
: "${VB_IMAGE:=serenedb/serenedb:26.09.1}"
# Native mode: when VB_BINARY names a `serened` executable the scripts run it directly (no docker),
# which is how a locally built server is benchmarked without building an image. No memory cap applies;
# the CPU set is applied with taskset.
: "${VB_BINARY:=}"
: "${VECTORBENCH_ENGINE_DIR:=${PWD}/serened_data}"
: "${VECTORBENCH_DATASET_DIR:=}"
: "${VECTORBENCH_CPUSET:=}"
: "${VECTORBENCH_MEMORY:=}"

PY="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.venv/bin/python"
[[ -x "$PY" ]] || PY="$(command -v python3)"

PIDFILE="$VECTORBENCH_ENGINE_DIR/serened.pid"

native_pid() {  # prints the pid of a live native server, or nothing
    [[ -f "$PIDFILE" ]] || return 0
    local pid; pid="$(cat "$PIDFILE" 2>/dev/null || true)"
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && echo "$pid"
    return 0
}

# psql-free helpers: every SQL round trip goes through the venv's psycopg.
sql() {  # sql "<statement>" -> prints rows tab-separated
    "$PY" - "$VB_PORT" "$1" <<'EOF'
import sys, psycopg
port, stmt = int(sys.argv[1]), sys.argv[2]
with psycopg.connect(host="127.0.0.1", port=port, user="postgres", dbname="postgres", autocommit=True) as c:
    cur = c.execute(stmt)
    if cur.description:
        for row in cur.fetchall():
            print("\t".join("" if v is None else str(v) for v in row))
EOF
}

engine_answers() {  # exit 0 iff a trivial query works
    "$PY" - "$VB_PORT" <<'EOF' >/dev/null 2>&1
import sys, psycopg
with psycopg.connect(host="127.0.0.1", port=int(sys.argv[1]), user="postgres", dbname="postgres", connect_timeout=2) as c:
    c.execute("SELECT 1").fetchone()
EOF
}
