#!/bin/sh
set -e

# Fix volume permissions — Docker volumes default to root ownership
# but the app runs as appuser (uid 1000). We run this as root
# (docker-compose sets user: root for our entrypoint), fix perms,
# then drop to appuser for the actual app.
chmod -R 777 /app/data /app/data/images /app/backups 2>/dev/null || true
mkdir -p /app/data /app/data/images /app/backups

# Drop to appuser and run the actual command
exec runuser -u appuser -- "$@"
