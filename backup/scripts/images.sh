#!/bin/bash
# Manual images-only archival (ad-hoc use).  The SCHEDULED full backup already
# includes the images tarball — this exists for on-demand media refreshes.
# Usage: /opt/backup/images.sh
# Produces system_backups/images/images-<stamp>.tar.zst.gpg + retains N copies.

set -euo pipefail

STORE="${BACKUP_STORE:-/backups/system_backups}"
LOG="/var/log/system_backup.log"
STAMP="$(date -u +%Y%m%d-%H%M%S)"

# shellcheck disable=SC1091
source "$(dirname "$0")/functions.sh"
log() { echo "[images ${STAMP}] $*" >> "${LOG}"; }
die() { log "ERROR: $*"; echo "[images ${STAMP}] ERROR: $*" >&2; exit 1; }

log "starting (manual images-only archive)"
archive_images "${STAMP}" || die "images archive failed"
retain_images "${BACKUP_RETAIN_DUMPS:-14}"

jq -n \
  --arg stamp "${STAMP}" \
  --arg sha256 "${ARCHIVE_SHA}" \
  --arg size "${ARCHIVE_SIZE}" \
  '{stamp: $stamp, type: "images", sha256: $sha256, size_bytes: ($size | tonumber)}' \
  > "${STORE}/manifests/images-${STAMP}.json"
log "finished"
echo "[images ${STAMP}] finished (${ARCHIVE_SIZE} bytes, sha256 ${ARCHIVE_SHA})"