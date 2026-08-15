#!/bin/sh
set -e

# Fix volume permissions — Docker volumes default to root ownership
# but the app runs as appuser (uid 1000). We run this as root
# (docker-compose sets user: root for our entrypoint), fix perms,
# then drop to appuser for the actual app.
chmod -R 777 /app/data /app/data/images /app/backups 2>/dev/null || true
mkdir -p /app/data /app/data/images /app/backups

# Apply database migrations before the app starts. Idempotent (no-op when the
# schema is already current) — this is what makes a fresh `docker compose up`
# work without a manual `alembic upgrade head`. Gated by RUN_MIGRATIONS so the
# Celery worker (same image) never races the backend on the same schema.
if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
    echo "[entrypoint] Applying database migrations (alembic upgrade head)..."
    runuser -u appuser -- alembic upgrade head
fi

# Drop to appuser and run the actual command
exec runuser -u appuser -- "$@"
