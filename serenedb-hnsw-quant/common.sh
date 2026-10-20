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

port_taken() {  # exit 0 iff something is already listening on VB_PORT
    "$PY" - "$VB_PORT" <<'EOF'
import socket, sys
s = socket.socket()
s.settimeout(1)
sys.exit(0 if s.connect_ex(("127.0.0.1", int(sys.argv[1]))) == 0 else 1)
EOF
}

# A port held by an engine this script did not start is the worst kind of success:
# ./start returns 0, ./check answers, ./load drops and recreates `items` in whatever
# database is actually there, and every number after that describes the wrong index.
# Refuse instead.
refuse_foreign_port() {
    port_taken || return 0
    echo "port $VB_PORT is already in use by a process this script did not start;" >&2
    echo "  stop it (or set VB_PORT) before starting $VB_CONTAINER" >&2
    exit 1
}

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
