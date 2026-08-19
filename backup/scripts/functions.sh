#!/bin/bash
# Shared helpers for backup jobs (sourced by full.sh and images.sh).

STORE="${BACKUP_STORE:-/backups/system_backups}"
LOG="${BACKUP_LOG:-/var/log/system_backup.log}"
KEY="${STORE}/keys/.backup_key"

# archive_images <stamp> — tarball the images + review_batch volumes and
# encrypt with the store key into $STORE/images/images-<stamp>.tar.zst.gpg.
# Sets ARCHIVE, ARCHIVE_SHA, ARCHIVE_SIZE.  Returns non-zero on failure.
archive_images() {
  local stamp="$1"
  ARCHIVE="${STORE}/images/images-${stamp}.tar.zst.gpg"
  log "tar → zstd → AES256(gpg store key) → ${ARCHIVE}"
  tar -C /system-raw --warning=no-file-changed --ignore-failed-read \
      -cf - images review_batch 2>>"${LOG}" \
    | zstd -q -T0 \
    | gpg --batch --yes --quiet --symmetric --cipher-algo AES256 \
        --passphrase-file "${KEY}" --output "${ARCHIVE}" 2>>"${LOG}" \
    || { log "ERROR: images archive pipeline failed (rc=$?)"; rm -f "${ARCHIVE}"; return 1; }
  ARCHIVE_SHA="$(sha256sum "${ARCHIVE}" | awk '{print $1}')"
  ARCHIVE_SIZE="$(stat -c %s "${ARCHIVE}")"
  log "images archived (${ARCHIVE_SIZE} bytes, sha256 ${ARCHIVE_SHA})"
}

retain_images() {
  local retain="${1:-14}"
  find "${STORE}/images" -name 'images-*.tar.zst.gpg' -type f | sort -r \
    | tail -n +$((retain + 1)) | xargs -r rm -f
  # Legacy artifacts from before images were encrypted in this job:
  find "${STORE}/images" \( -name 'images-*.tar.zst' -o -name 'images-*.json' \) -type f \
    | xargs -r rm -f
  find "${STORE}/manifests" -name 'images-*.json' -type f | xargs -r rm -f
  log "images retention: keep ${retain}"
}