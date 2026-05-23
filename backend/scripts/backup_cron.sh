#!/bin/sh
# Automated database backup via docker exec.
# Run from host:  ./backend/scripts/backup_cron.sh
# Or add to crontab:  0 3 * * * /path/to/scripts/backup_cron.sh

BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-7}
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/scanapp_db_$TIMESTAMP.sql.gz"

mkdir -p "$BACKUP_DIR"

echo "[$(date)] Starting backup..."

# Dump from postgres container (no extra packages needed)
docker exec scan-app-postgres pg_dump -U scanapp scanapp 2>/dev/null | gzip > "$BACKUP_FILE"

if [ -s "$BACKUP_FILE" ]; then
    cp "$BACKUP_FILE" "$BACKUP_DIR/scanapp_db_latest.sql.gz"
    echo "[$(date)] Backup OK: $(du -h "$BACKUP_FILE" | cut -f1)"
else
    echo "[$(date)] Backup FAILED — is postgres running?"
    rm -f "$BACKUP_FILE"
    exit 1
fi

# Rotate old backups
find "$BACKUP_DIR" -name "scanapp_db_*.sql.gz" -mtime +$RETENTION_DAYS -delete 2>/dev/null

echo "[$(date)] Done — $(find "$BACKUP_DIR" -name '*.sql.gz' | wc -l) backups retained"

