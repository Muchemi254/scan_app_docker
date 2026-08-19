#!/bin/bash
# System-backup sidecar entrypoint.
#
#  1. Prepare the encrypted store layout on the shared backup_data volume.
#  2. Generate the store encryption key on first boot (never in git/env).
#  3. Install the cron schedule and run it.

set -e

STORE="${BACKUP_STORE:-/backups/system_backups}"
mkdir -p "${STORE}"/wal "${STORE}"/dumps "${STORE}"/images "${STORE}"/keys "${STORE}"/manifests

# Wal-G (in the postgres container) runs as the postgres UID and must be able
# to append WAL segments and read the encryption key.  Own the store parts by
# the postgres user/group; the sidecar runs wal-g operations as root which can
# write anywhere.
PG_UID="$(id -u postgres || echo 999)"
PG_GID="$(id -g postgres || echo 999)"
chown -R "${PG_UID}:${PG_GID}" "${STORE}"/wal "${STORE}"/keys

KEY="${STORE}/keys/.backup_key"
if [ ! -s "${KEY}" ]; then
  openssl rand -hex 32 > "${KEY}"
  echo "[backup] generated store encryption key ${KEY}"
fi
chmod 640 "${KEY}"
chown "${PG_UID}:${PG_GID}" "${KEY}"

# ── cron schedule (overridable via compose env) ───────────────────────────────
# A single full job backs up the ENTIRE system (DB + images) in one process;
# the run only reports complete when both parts succeeded.
CRON_FULL="${CRON_FULL:-0 2 * * *}"
CRON_VERIFY="${CRON_VERIFY:-0 4 * * 0}"

{
  echo "${CRON_FULL} /opt/backup/full.sh >> /var/log/system_backup.log 2>&1"
  echo "${CRON_VERIFY} /opt/backup/verify.sh >> /var/log/system_backup.log 2>&1"
} | crontab -

echo "[backup] schedule installed:
  ${CRON_FULL}  full backup (Wal-G base + pg_dump + images tarball, one process)
  ${CRON_VERIFY}  restore-into-scratch verification"

exec "$@"