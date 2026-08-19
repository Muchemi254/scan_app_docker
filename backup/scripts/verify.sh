#!/bin/bash
# Weekly verification: prove the latest FULL backup is restorable — both halves
# of it:
#   1. restore the latest encrypted pg_dump into a scratch database and validate
#   2. decrypt-then-integrity-check the latest images tarball (sha256 vs the
#      full manifest) so the media half is proven readable
# Fails loudly in the logs.  The Wal-G base/PITR physical path is exercised
# separately by ops/restore/restore.sh (a full restore drill).

set -euo pipefail

STORE="${BACKUP_STORE:-/backups/system_backups}"
LOG="/var/log/system_backup.log"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
SCRATCH="scanapp_verify"

log() { echo "[verify ${STAMP}] $*" >> "${LOG}"; }
die() { log "FAILED: $*"; echo "[verify ${STAMP}] FAILED: $*" >&2; exit 1; }

LATEST_DUMP="$(find "${STORE}/dumps" -name '*.dump.gpg' -type f | sort -r | head -n 1 || true)"
[ -n "${LATEST_DUMP:-}" ] || die "no encrypted dump to verify"

log "verifying latest dump: ${LATEST_DUMP}"

WORKD="${STORE}/restore"
mkdir -p "${WORKD}"
DECRYPTED="${WORKD}/verify.dump"
gpg --batch --yes --quiet --decrypt --passphrase-file "${STORE}/keys/.backup_key" \
  -o "${DECRYPTED}" "${LATEST_DUMP}" || die "dump decrypt failed"

psql -h "${PGHOST:-postgres}" -U "${PGUSER}" -d postgres -v ON_ERROR_STOP=1 <<SQL >>"${LOG}" 2>&1 || die "scratch db setup failed"
DROP DATABASE IF EXISTS ${SCRATCH};
CREATE DATABASE ${SCRATCH};
SQL

pg_restore -h "${PGHOST:-postgres}" -U "${PGUSER}" -d "${SCRATCH}" \
  --no-owner --no-privileges --exit-on-error "${DECRYPTED}" >>"${LOG}" 2>&1 \
  || die "pg_restore failed"

TABLES="$(psql -h "${PGHOST:-postgres}" -U "${PGUSER}" -d "${SCRATCH}" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name <> 'alembic_version'" 2>/dev/null || echo 0)"
ALEMBIC="$(psql -h "${PGHOST:-postgres}" -U "${PGUSER}" -d "${SCRATCH}" \
  -tAc "SELECT version_num FROM alembic_version" 2>/dev/null || echo unknown)"

psql -h "${PGHOST:-postgres}" -U "${PGUSER}" -d postgres -qc "DROP DATABASE IF EXISTS ${SCRATCH};" >>"${LOG}" 2>&1 || true
rm -f "${DECRYPTED}"

[ "${TABLES:-0}" -gt 0 ] || die "restore produced no tables"
log "DB half PASS: ${TABLES} tables restored, alembic_version=${ALEMBIC}"
echo "[verify ${STAMP}] DB PASS (${TABLES} tables, alembic ${ALEMBIC})"

# ── 2. Images half: decrypt + integrity + entry count.  The tarball to check
# ──    is taken from the SAME full manifest as the dump (single-process pairing).
DUMP_STAMP="$(basename "${LATEST_DUMP}" .dump.gpg)"
MANIFEST="${STORE}/manifests/${DUMP_STAMP}.json"
[ -s "${MANIFEST}" ] || die "full manifest ${MANIFEST} missing"
LATEST_ARCHIVE="${STORE}/images/$(jq -r '.images_archive // empty' "${MANIFEST}")"
[ -n "${LATEST_ARCHIVE#*/.}" ] || die "full manifest ${MANIFEST} has no images_archive"
[ -f "${LATEST_ARCHIVE}" ] || die "manifest images archive missing: ${LATEST_ARCHIVE}"
MANIFEST_SHA="$(jq -r '.images_sha256 // empty' "${MANIFEST}")"
[ -n "${MANIFEST_SHA}" ] || die "full manifest ${MANIFEST} has no images_sha256"

log "verifying images archive: ${LATEST_ARCHIVE} (paired by manifest ${MANIFEST})"
FILE_SHA="$(sha256sum "${LATEST_ARCHIVE}" | awk '{print $1}')"
[ "${FILE_SHA}" = "${MANIFEST_SHA}" ] || die "images archive sha256 mismatch (manifest ${MANIFEST_SHA} vs file ${FILE_SHA})"
UNENCRYPTED="${WORKD}/verify-images.tar.zst"
gpg --batch --yes --quiet --decrypt --passphrase-file "${STORE}/keys/.backup_key" \
  -o "${UNENCRYPTED}" "${LATEST_ARCHIVE}" || die "images decrypt failed"
zstd -t "${UNENCRYPTED}" >>"${LOG}" 2>&1 || die "images zstd integrity check failed"
ENTRIES="$(tar -tf "${UNENCRYPTED}" | wc -l)"
[ "${ENTRIES:-0}" -gt 0 ] || die "images archive is empty"
rm -f "${UNENCRYPTED}"

log "images half PASS: sha256 matches manifest, ${ENTRIES} entries"
echo "[verify ${STAMP}] PASS (${TABLES} tables, alembic ${ALEMBIC}, images ${ENTRIES} entries)"