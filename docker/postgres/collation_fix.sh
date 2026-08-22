#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# One-shot Postgres collation auto-fix (runs BEFORE the postgres service).
#
# WHY: before the wal-g/glibc image switch, clusters were initdb'd by
# postgres:16-alpine (musl), where the `en_US.utf8` locale behaves as plain
# byte-order (like C). Under glibc the SAME datcollate is a real locale, so
# every btree index on a text column silently disagrees with the collation
# used at query time: index lookups return 0 rows while the rows exist.
# The app then 401s everything ("User no longer exists") because the
# user-by-uid lookup misses through the unique index.
#
# WHAT: detects a non-C.UTF-8 datcollate on an existing cluster, dumps it
# (custom format), snapshots the old cluster to the pgdata-old volume
# (/fix/old/pre_collation_fix), initdb's a fresh C.UTF-8 cluster, restores the
# dump, then exits 0. Idempotent: every later boot just re-checks datcollate
# and exits immediately.
#
# SAFETY: user data is never deleted — the old cluster is preserved verbatim in
# the pgdata-old volume and as a pg_dump in the collation-fix-backups volume.
# The marker .collation_fixed is only written after a fully verified restore.
# Any failure exits non-zero, which aborts `docker compose up` before postgres
# ever starts on partial data.
# ---------------------------------------------------------------------------
set -euo pipefail

PGDATA="${PGDATA:-/var/lib/postgresql/data}"
PGUSER="${POSTGRES_USER:-postgres}"
PGDB="${POSTGRES_DB:-postgres}"
PGPASSWORD="${POSTGRES_PASSWORD:-}"
PGAUTH="${POSTGRES_HOST_AUTH_METHOD:-scram-sha-256}"
BACKUP_DIR="/fix-backups"
# Old cluster snapshot goes to the dedicated pgdata-old volume (mounted at
# /fix/old). It must NOT live inside PGDATA — initdb requires that directory
# to be completely empty — and it cannot share the pgdata volume/mount (the
# kernel refuses rename() across bind mounts and cp refuses copy-into-self).
OLD_DATA="/fix/old/pre_collation_fix"
SOCKET_DIR="/tmp/pgfix"
MARKER="$BACKUP_DIR/.collation_fixed"
LOG="$BACKUP_DIR/collation_fix.log"

log() { printf '%s\n' "[$(date -u +%FT%TZ)] collation-fix: $*" | tee -a "$LOG"; }

as_pg() {
  if [ "$(id -u)" = "0" ]; then
    gosu postgres "$@"
  else
    "$@"
  fi
}

start_server() { as_pg pg_ctl -D "$PGDATA" -o "-c unix_socket_directories=$SOCKET_DIR" -w -t 60 start; }
stop_server() { as_pg pg_ctl -D "$PGDATA" -m fast -w -t 60 stop; }
psqlx() { as_pg env PGPASSWORD="$PGPASSWORD" PGHOST="$SOCKET_DIR" psql -X -A -t -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 -c "$1"; }
psql_db() { as_pg env PGPASSWORD="$PGPASSWORD" PGHOST="$SOCKET_DIR" psql -X -A -t -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 -c "$1"; }

ensure_host_auth() {
  # initdb only allows local + localhost TCP; the official entrypoint appends
  # host rules for remote containers right after initdb, but the fix script
  # bypasses it. Ensure they exist even when the marker short-circuits —
  # clusters migrated by older script versions lack them, and backend/worker
  # containers then get "no pg_hba.conf entry" and cannot connect.
  if [ -f "$PGDATA/pg_hba.conf" ]; then
    for rule in "host all all 0.0.0.0/0 $PGAUTH" "host all all ::/0 $PGAUTH"; do
      if ! grep -qF "$rule" "$PGDATA/pg_hba.conf"; then
        echo "$rule" >> "$PGDATA/pg_hba.conf"
        log "appended missing pg_hba rule: $rule"
      fi
    done
  fi
}

# ---------------------------------------------------------------------------
# Guards — exit 0 (no-op) unless a real migration is needed.
# ---------------------------------------------------------------------------
if [ "${POSTGRES_COLLATION_FIX_DISABLED:-0}" = "1" ]; then
  echo "collation-fix: disabled via POSTGRES_COLLATION_FIX_DISABLED=1"
  exit 0
fi

mkdir -p "$BACKUP_DIR"
# backup dir must be writable by the postgres user (pg_dump writes the dump there)
chown postgres:postgres "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
touch "$LOG"

if [ -f "$MARKER" ]; then
  log "already fixed previously (.collation_fixed present), skipping"
  ensure_host_auth
  exit 0
fi

if [ ! -d "$PGDATA" ] || [ ! -s "$PGDATA/PG_VERSION" ]; then
  log "empty/fresh pgdata — nothing to migrate"
  exit 0
fi

# The postgres service may ALREADY be running in another container (a re-up on
# a live stack). The fix only ever runs on a clean boot, so detect that case
# first: a naive PID check is useless here because postmaster.pid holds the PID
# from the postgres container's PID namespace, which collides with our own PID 1.
if pg_isready -h postgres -p 5432 -t 5 >/dev/null 2>&1; then
  log "postgres is ALREADY RUNNING in another container — evaluating whether the fix is still needed"
  LIVE_COLLATE="$(env PGPASSWORD="$PGPASSWORD" psql -h postgres -p 5432 -U "$PGUSER" -d postgres -X -A -t -v ON_ERROR_STOP=1 -c "SELECT datcollate FROM pg_database WHERE datname='$PGDB'" 2>/dev/null || true)"
  if [ -z "$LIVE_COLLATE" ]; then
    log "could not query the running server (host pg_hba may still block TCP) — leaving a running cluster alone"
    exit 0
  fi
  case "$LIVE_COLLATE" in
    C | C.UTF-8) log "cluster already byte-order collated ($LIVE_COLLATE) — nothing to do"; exit 0 ;;
  esac
  log "ERROR: cluster datcollate='$LIVE_COLLATE' but postgres is already running — cannot migrate a live server."
  log "Run: docker compose stop postgres && docker compose up -d postgres (this fix migrates on that clean boot)"
  exit 1
fi

# The previous postgres container may still be shutting down while we start.
if [ -f "$PGDATA/postmaster.pid" ]; then
  PID="$(sed -n 1p "$PGDATA/postmaster.pid" 2>/dev/null || true)"
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    log "postgres still running (pid $PID) — waiting up to 120s for it to stop..."
    for _ in $(seq 1 120); do
      if [ ! -f "$PGDATA/postmaster.pid" ]; then break; fi
      sleep 1
    done
  else
    log "stale postmaster.pid (pid ${PID:-?} not alive) — removing"
    rm -f "$PGDATA/postmaster.pid"
  fi
  if [ -f "$PGDATA/postmaster.pid" ]; then
    log "ERROR: postgres never stopped; aborting (will retry next boot)"
    exit 1
  fi
fi

chown -R postgres:postgres "$PGDATA"
rm -rf "$SOCKET_DIR"
mkdir -p "$SOCKET_DIR"
chown postgres:postgres "$SOCKET_DIR"

# ---------------------------------------------------------------------------
# Detect the collation of the existing cluster.
# ---------------------------------------------------------------------------
if ! start_server; then
  log "ERROR: existing cluster would not start — refusing to touch it. Investigate manually."
  exit 1
fi
COLLATE="$(psqlx "SELECT datcollate FROM pg_database WHERE datname='$PGDB'" || true)"
stop_server

if [ -z "$COLLATE" ]; then
  log "could not determine datcollate for database '$PGDB' — skipping fix"
  exit 0
fi
log "existing cluster datcollate='$COLLATE'"

case "$COLLATE" in
  C | C.UTF-8)
    # If the cluster is already byte-order collated but a previous run left old
    # data and no marker, that previous run crashed mid-restore — the fresh
    # cluster may hold PARTIAL data. Refuse to boot until the operator restores.
    if [ ! -f "$MARKER" ] && [ -d "$OLD_DATA" ] && [ -n "$(ls -A "$OLD_DATA" 2>/dev/null)" ]; then
      log "ERROR: cluster is C.UTF-8 but an earlier fix left old data without a marker —"
      log "it may be a partial restore. Manual recovery: stop postgres, then"
      log "  cp -a $OLD_DATA/. $PGDATA/"
      log "  docker compose rm -f postgres-collation-fix && docker compose up -d postgres"
      exit 1
    fi
    log "cluster already byte-order collated — nothing to do"
    exit 0
    ;;
esac

# Broken cluster + leftover snapshot from an earlier aborted run: the source
# cluster is still fully intact, so the leftover is stale garbage — discard it.
if [ -d "$OLD_DATA" ] && [ -n "$(ls -A "$OLD_DATA" 2>/dev/null)" ]; then
  log "discarding stale snapshot from an earlier aborted run (source cluster still intact)"
  rm -rf "$OLD_DATA"
fi

# ---------------------------------------------------------------------------
# Perform the migration: dump → swap → initdb(C.UTF-8) → restore → verify.
# ---------------------------------------------------------------------------
TS="$(date -u +%Y%m%d%H%M%S)"
DUMP="$BACKUP_DIR/pre_collation_fix_${TS}.dump"
log "non-byte-order cluster ($COLLATE) — rebuilding as C.UTF-8 (old data preserved)"

start_server
log "dumping '$PGDB' -> $DUMP"
as_pg env PGPASSWORD="$PGPASSWORD" PGHOST="$SOCKET_DIR" pg_dump -Fc -U "$PGUSER" -d "$PGDB" -f "$DUMP"
stop_server
chmod 600 "$DUMP"
log "dump complete ($(du -h "$DUMP" | cut -f1))"

log "snapshotting old cluster to the pgdata-old volume (/fix/old/pre_collation_fix)"
mkdir -p "$OLD_DATA"
cp -a "$PGDATA"/. "$OLD_DATA/"
if [ ! -s "$OLD_DATA/PG_VERSION" ]; then
  log "ERROR: old-data snapshot looks incomplete (no PG_VERSION); aborting"
  exit 1
fi
find "$PGDATA" -mindepth 1 -delete
if [ -n "$(ls -A "$PGDATA" 2>/dev/null)" ]; then
  log "ERROR: could not clear pgdata after snapshot; aborting"
  exit 1
fi

PWFILE="$SOCKET_DIR/pwfile"
if [ -n "$PGPASSWORD" ]; then
  printf '%s' "$PGPASSWORD" > "$PWFILE"
  chown postgres:postgres "$PWFILE"
  chmod 600 "$PWFILE"
  PWARGS=(--pwfile="$PWFILE")
else
  PWARGS=()
fi

log "initdb'ing fresh cluster under C.UTF-8"
as_pg env LANG=C.UTF-8 LC_ALL=C.UTF-8 LC_COLLATE=C.UTF-8 LC_CTYPE=C.UTF-8 \
  initdb -D "$PGDATA" -U "$PGUSER" -A "$PGAUTH" -E UTF8 "${PWARGS[@]}" >/dev/null

# initdb only allows local + localhost TCP; the official entrypoint appends
# host rules for remote containers right after initdb. Without this, backend/
# worker containers cannot connect ("no pg_hba.conf entry ... no encryption").
ensure_host_auth

start_server
if [ "$(psql_db "SELECT 1 FROM pg_database WHERE datname='$PGDB'")" != "1" ]; then
  log "creating database '$PGDB'"
  as_pg env PGPASSWORD="$PGPASSWORD" PGHOST="$SOCKET_DIR" createdb -U "$PGUSER" -O "$PGUSER" "$PGDB"
fi
log "restoring dump (exit-on-error)"
as_pg env PGPASSWORD="$PGPASSWORD" PGHOST="$SOCKET_DIR" pg_restore --exit-on-error -j "$(nproc)" -U "$PGUSER" -d "$PGDB" "$DUMP"
stop_server

log "verifying restored cluster"
start_server
VERIFY_COLLATE="$(psql_db "SELECT datcollate FROM pg_database WHERE datname='$PGDB'")"
VERIFY_CTYPE="$(psql_db "SELECT datctype FROM pg_database WHERE datname='$PGDB'")"
TABLE_COUNT="$(psql_db "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
stop_server

if [ "$VERIFY_COLLATE" != "C.UTF-8" ]; then
  log "ERROR: collation after fix is '$VERIFY_COLLATE', expected C.UTF-8"
  exit 1
fi

touch "$MARKER"
log "FIX COMPLETE — datcollate=$VERIFY_COLLATE (ctype=$VERIFY_CTYPE), $TABLE_COUNT public tables restored"
log "Old data kept at $OLD_DATA, dump at $DUMP"
exit 0
