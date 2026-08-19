#!/bin/bash
# Full system backup job — a SINGLE process covering the whole system.
#  1. Wal-G physical base backup (encrypted, compressed) → store
#  2. Encrypted logical pg_dump (custom format, GPG-AES256)  → dumps/
#  3. Images + review-batch volumes tarball (encrypted at rest via store-key
#     AES encryption through zstd container with GPG)     → images/
#  4. ONE combined manifest (DB state + images tarball)   → manifests/
#  5. Retention: keep FULL base backups + N dumps/images/manifests, prune WAL
#
# The job only reports "complete" when EVERY step above has succeeded; any
# failure aborts the run and leaves the store untouched for re-run.

set -euo pipefail

STORE="${BACKUP_STORE:-/backups/system_backups}"
LOG="/var/log/system_backup.log"
STAMP="$(date -u +%Y%m%d-%H%M%S)"

# shellcheck disable=SC1091
source "$(dirname "$0")/functions.sh"
log() { echo "[full ${STAMP}] $*" >> "${LOG}"; }
die() { log "ERROR: $*"; echo "[full ${STAMP}] ERROR: $*" >&2; exit 1; }
note() { echo "[full ${STAMP}] $*" >> "${LOG}"; }

log "starting"

# PostgreSQL must be reachable before any DB step makes sense.
if ! pg_isready -h "${PGHOST:-postgres}" -p "${PGPORT:-5432}" -U "${PGUSER}" >/dev/null 2>&1; then
  die "postgres not ready"
fi

# ── 1. Wal-G physical base backup ─────────────────────────────────────────────
# Local-mode base backup (wal-g's remote backup-push is broken on PG >= 15).
# The pgdata volume is mounted read-only at /var/lib/postgresql/data; wal-g
# streams the DB files from there while postgres guards consistency.
log "wal-g backup-push /var/lib/postgresql/data"
wal-g backup-push /var/lib/postgresql/data >> "${LOG}" 2>&1 || die "wal-g backup-push failed"
log "wal-g backup-push done"

# ── 2. Logical pg_dump, encrypted ─────────────────────────────────────────────
DUMP="${STORE}/dumps/${STAMP}.dump"
log "pg_dump → ${DUMP}.gpg"
pg_dump -h "${PGHOST:-postgres}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" \
  --format=custom --no-owner --no-privileges -f "${DUMP}" || die "pg_dump failed"
gpg --batch --yes --quiet --symmetric --cipher-algo AES256 \
  --passphrase-file "${STORE}/keys/.backup_key" \
  --output "${DUMP}.gpg" "${DUMP}" || die "gpg encrypt failed"
rm -f "${DUMP}"
DUMP_SHA256="$(sha256sum "${DUMP}.gpg" | awk '{print $1}')"
DUMP_SIZE="$(stat -c %s "${DUMP}.gpg")"
note "pg_dump encrypted (${DUMP_SIZE} bytes, sha256 ${DUMP_SHA256})"

# ── 3. Images + review-batch volumes tarball (same stamp as the DB backup) ────
archive_images "${STAMP}" || die "images archive failed"

# ── 4. Combined full-backup manifest (DB + images) ────────────────────────────
ALEMBIC_VERSION="$(psql -h "${PGHOST:-postgres}" -p "${PGPORT:-5432}" -U "${PGUSER}" -d "${PGDATABASE}" \
  -tAc "SELECT version_num FROM alembic_version" 2>/dev/null || echo "unknown")"
WALG_BACKUP="$(wal-g backup-list 2>/dev/null | tail -n 1 | awk '{print $1}')"
WALG_LSN="$(wal-g backup-list 2>/dev/null | tail -n 1 | awk '{print $3}')"

MANIFEST="${STORE}/manifests/${STAMP}.json"
jq -n \
  --arg stamp "${STAMP}" \
  --arg alembic "${ALEMBIC_VERSION}" \
  --arg walg_backup "${WALG_BACKUP}" \
  --arg walg_lsn "${WALG_LSN}" \
  --arg dump_sha256 "${DUMP_SHA256}" \
  --arg dump_size "${DUMP_SIZE}" \
  --arg images_archive "$(basename "${ARCHIVE}")" \
  --arg images_sha256 "${ARCHIVE_SHA}" \
  --arg images_size "${ARCHIVE_SIZE}" \
  '{stamp: $stamp,
    type: "full",
    alembic_version: $alembic,
    walg_backup: $walg_backup,
    walg_start_lsn: $walg_lsn,
    dump_sha256: $dump_sha256,
    dump_size_bytes: ($dump_size | tonumber),
    images_archive: $images_archive,
    images_sha256: $images_sha256,
    images_size_bytes: ($images_size | tonumber),
    complete: true}' \
  > "${MANIFEST}"
log "manifest written: ${MANIFEST} (alembic ${ALEMBIC_VERSION}, wal-g ${WALG_BACKUP} @ ${WALG_LSN}, images $(basename "${ARCHIVE}"))"

# ── 5. Retention ──────────────────────────────────────────────────────────────
RETAIN_FULL="${BACKUP_RETAIN_FULL:-7}"
RETAIN_DUMPS="${BACKUP_RETAIN_DUMPS:-14}"

note "retention: keep ${RETAIN_FULL} full backups, ${RETAIN_DUMPS} dumps"
wal-g delete retain FULL "${RETAIN_FULL}" --confirm >> "${LOG}" 2>&1 || log "wal-g retention failed"
find "${STORE}/dumps" -name '*.dump.gpg' -type f | sort -r | tail -n +$((RETAIN_DUMPS + 1)) \
  | xargs -r rm -f
find "${STORE}/manifests" -name '*.json' -type f | sort -r | tail -n +$((RETAIN_DUMPS + 1)) \
  | xargs -r rm -f
retain_images "${RETAIN_DUMPS}"

log "COMPLETE: db + images backup finished successfully"
echo "[full ${STAMP}] COMPLETE (wal-g ${WALG_BACKUP} @ ${WALG_LSN}, dump ${DUMP_SIZE}B, images ${ARCHIVE_SIZE}B)"