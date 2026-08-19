#!/bin/bash
# Full-system restore drill — restores into a SCRATCH container, never touching
# the live postgres.  Use this to recover after a disaster or to rehearse.
#
#   ./restore.sh --latest              # newest base backup (as-of its end)
#   ./restore.sh --backup <NAME>       # a specific wal-g backup name
#   ./restore.sh --latest --time ISO   # point-in-time recovery to a UTC instant
#
# After a successful restore-to-scratch, VERIFY the data, then promote by
# following the printed steps.  See ops/restore/README.md for the full runbook,
# conflict & migration guidance.
#
# Requirements: docker, access to the backup_data volume + repo .env.

set -euo pipefail

cd "$(dirname "$0")"

IMG="${RESTORE_IMG:-scan-app-postgres-walg:16}"
VOL_PREFIX="${RESTORE_VOL_PREFIX:-scan_app_docker}"
RESTORE_VOL="${VOL_PREFIX}_restore_pgdata"
RESTORE_NAME="${RESTORE_NAME:-scan-app-restore}"
RESTORE_PORT="${RESTORE_PORT:-55432}"
WALG_FILE_PREFIX="/backups/system_backups/wal"
WALG_KEY="/backups/system_backups/keys/.backup_key"

MODE="latest"
TIME_STR=""
BACKUP_NAME=""

while [ $# -gt 0 ]; do
  case "$1" in
    --latest) MODE="latest" ;;
    --backup) MODE="named"; BACKUP_NAME="$2"; shift ;;
    --time) TIME_STR="$2"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

# ── credentials from repo .env ──────────────────────────────────────────────
ENV_FILE="$(pwd)/../../.env"
PGUSER="$(grep -E '^POSTGRES_USER=' "${ENV_FILE}" | cut -d= -f2)"
PGPASS="$(grep -E '^DB_PASSWORD=' "${ENV_FILE}" | cut -d= -f2)"
PGDB="$(grep -E '^POSTGRES_DB=' "${ENV_FILE}" | cut -d= -f2)"
[ -n "${PGUSER}" ] && [ -n "${PGPASS}" ] && [ -n "${PGDB}" ] || { echo "ERROR: POSTGRES creds missing in .env" >&2; exit 2; }

WALG_ENV=(
  -e WALG_FILE_PREFIX="${WALG_FILE_PREFIX}"
  -e WALG_LIBSODIUM_KEY_PATH="${WALG_KEY}"
  -e WALG_COMPRESSION_METHOD=zstd
)

echo "==> image: ${IMG}"
docker image inspect "${IMG}" >/dev/null 2>&1 || { echo "Image ${IMG} not built — run: docker compose build postgres" >&2; exit 1; }

# ── locate the volume that actually holds the backup store ───────────────────
# compose mounts backup_data as <project>_backup_data; a stale unprefixed
# volume may also exist (older compose iterations).  Probe candidates instead
# of trusting the name, so an empty leftover volume is never picked.
BACKUPS_VOL=""
for cand in "${VOL_PREFIX}_backup_data" "backup_data"; do
  docker volume inspect "${cand}" >/dev/null 2>&1 || continue
  if docker run --rm -v "${cand}:/backups" -e WALG_FILE_PREFIX="${WALG_FILE_PREFIX}" \
      -e WALG_LIBSODIUM_KEY_PATH="${WALG_KEY}" "${IMG}" \
      sh -c 'test -d /backups/system_backups/wal && test -n "$(ls -A /backups/system_backups/wal/basebackups_* 2>/dev/null)"' \
      >/dev/null 2>&1; then
    BACKUPS_VOL="${cand}"
    break
  fi
done
[ -n "${BACKUPS_VOL}" ] || { echo "No volume holds a wal-g store (checked ${VOL_PREFIX}_backup_data, backup_data)" >&2; exit 1; }
echo "==> store volume: ${BACKUPS_VOL}"

# ── identify the base backup ─────────────────────────────────────────────────
if [ "${MODE}" = "named" ]; then
  [ -n "${BACKUP_NAME}" ] || { echo "--backup requires a name" >&2; exit 2; }
elif [ "${MODE}" = "latest" ]; then
  BACKUP_NAME="$(docker run --rm -v "${BACKUPS_VOL}:/backups" "${WALG_ENV[@]}" \
    "${IMG}" wal-g backup-list 2>/dev/null | tail -n 1 | awk '{print $1}' || true)"
  [ -n "${BACKUP_NAME}" ] || { echo "No base backups found in store" >&2; exit 1; }
fi
echo "==> restoring base backup: ${BACKUP_NAME}"

# ── fresh scratch data volume ────────────────────────────────────────────────
docker rm -f "${RESTORE_NAME}" >/dev/null 2>&1 || true
docker volume rm -f "${RESTORE_VOL}" >/dev/null 2>&1 || true
docker volume create "${RESTORE_VOL}" >/dev/null
echo "==> fetching backup into fresh volume ${RESTORE_VOL}"
docker run --rm -v "${BACKUPS_VOL}:/backups" -v "${RESTORE_VOL}:/newdata" \
  "${WALG_ENV[@]}" "${IMG}" sh -c \
  "chown \$(id -u postgres):\$(id -g postgres) /newdata && \
   wal-g backup-fetch /newdata ${BACKUP_NAME} && \
   chown -R \$(id -u postgres):\$(id -g postgres) /newdata" \
  || { echo "backup-fetch failed" >&2; exit 1; }

# ── recovery config (postgresql.auto.conf + recovery.signal) ────────────────
read -r -d '' AUTO <<RECOVERY || true
restore_command = 'wal-g wal-fetch %f %p'
RECOVERY
if [ -n "${TIME_STR}" ]; then
  AUTO="${AUTO}"$'\n'"recovery_target_time = '${TIME_STR}'"$'\n'"recovery_target_timeline = 'latest'"
fi
docker run --rm -v "${RESTORE_VOL}:/d" -e "AUTO=${AUTO}" "${IMG}" sh -c \
  'printf "%s" "$AUTO" > /d/postgresql.auto.conf && touch /d/recovery.signal && chown $(id -u postgres):$(id -g postgres) /d/postgresql.auto.conf /d/recovery.signal'

echo "==> starting scratch postgres at 127.0.0.1:${RESTORE_PORT}"
docker run -d --name "${RESTORE_NAME}" \
  --network "${VOL_PREFIX}_data-network" \
  -p "127.0.0.1:${RESTORE_PORT}:5432" \
  -v "${RESTORE_VOL}:/var/lib/postgresql/data" \
  -v "${BACKUPS_VOL}:/backups" \
  "${WALG_ENV[@]}" \
  "${IMG}" >/dev/null || { echo "failed to start restore container" >&2; exit 1; }

echo "==> waiting for recovery to complete (WAL replay)"
for i in $(seq 1 60); do
  if docker exec -e PGPASSWORD="${PGPASS}" "${RESTORE_NAME}" pg_isready \
     -U "${PGUSER}" -h 127.0.0.1 >/dev/null 2>&1; then break; fi
  sleep 2
done
sleep 3
docker exec -e PGPASSWORD="${PGPASS}" "${RESTORE_NAME}" pg_isready -U "${PGUSER}" -h 127.0.0.1 \
  || { echo "restore container not ready; logs:" >&2; docker logs "${RESTORE_NAME}" 2>&1 | tail -40; exit 1; }

# ── verification ─────────────────────────────────────────────────────────────
TABLES="$(docker exec -e PGPASSWORD="${PGPASS}" "${RESTORE_NAME}" psql -U "${PGUSER}" -d "${PGDB}" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name <> 'alembic_version'")"
RESTORED_ALEMBIC="$(docker exec -e PGPASSWORD="${PGPASS}" "${RESTORE_NAME}" psql -U "${PGUSER}" -d "${PGDB}" -tAc \
  "SELECT version_num FROM alembic_version")"

HEAD="$(grep -hE '^revision' ../../backend/alembic/versions/*.py | sed -E 's/revision[:=].*"([0-9]+)".*/\1/' | sort | tail -n 1 || echo 016)"
echo ""
echo "================================================================"
echo " Restore of '${BACKUP_NAME}' is RUNNING at 127.0.0.1:${RESTORE_PORT}"
echo "   tables restored : ${TABLES}"
echo "   alembic_version : ${RESTORED_ALEMBIC}  (repo head: ${HEAD})"
if [ "${RESTORED_ALEMBIC}" \> "${HEAD}" ]; then
  echo "   ⚠  RESTORED DATA IS NEWER THAN THIS APP CODE."
  echo "      Do not point the app at it until the code is upgraded."
elif [ "${RESTORED_ALEMBIC}" \< "${HEAD}" ]; then
  echo "   → data is N migrations behind current code."
  echo "     On promotion the backend will auto-run: alembic upgrade head"
fi
echo ""
echo " Verify here (psql on host):  PGPASSWORD=... psql -h 127.0.0.1 -p ${RESTORE_PORT} -U ${PGUSER} -d ${PGDB}"
echo ""
echo " Promote (manual, deliberate):"
echo "   1. docker compose stop backend worker postgres"
echo "   2. (optional) rename live volume: docker volume create ${VOL_PREFIX}_pgdata_old  # manual step"
echo "   3. Re-point compose 'postgres' to use this restored data (volume swap) and start."
echo "   4. docker compose up -d   (backend auto-applies forward migrations if behind)"
echo "   5. Restore images/review-batch (decrypt+decompress with the store key,"
echo "      e.g. gpg -d images-<stamp>.tar.zst.gpg | zstd -d | tar -xC /system-raw),"
echo "      reconcile via image_sha256."
echo "   6. Run ops/restore/verify again, then start scanning traffic."
echo " Clean up scratch when done: docker rm -f ${RESTORE_NAME} && docker volume rm -f ${RESTORE_VOL}"
echo "================================================================"