# AGENTS.md

## Stack

React 19 (Vite + TypeScript + Tailwind) → Nginx → FastAPI (Python) → Postgres auth (bcrypt + JWT) + Gemini API
Redis + Celery for async batch processing. Firebase is deprecated (kept only behind `AUTH_MODE=firebase`).

## Docker Commands

```bash
docker-compose up -d                    # start all services
docker-compose logs -f backend          # FastAPI logs
docker-compose logs -f frontend         # Nginx logs
docker-compose exec backend bash        # shell into backend
docker-compose build --no-cache         # rebuild after dep changes
docker-compose ps                       # health check
```

## Access

| Service  | URL                        |
|----------|----------------------------|
| Frontend | http://localhost:8081       |
| Backend  | http://localhost:8003       |
| API docs | http://localhost:8003/docs  |
| Health   | http://localhost:8003/health|

Frontend served through Nginx (port 8081), backend on 8003 (mapped from container port 8000).

## Firebase Credentials

Only needed for `AUTH_MODE=firebase` (legacy). Backend mounts the **service account JSON file** at `/app/firebaseservice.json` (from `./firebaseservice.json` in repo root), set via `FIREBASE_CREDENTIALS_PATH`. **Do not** use individual `FIREBASE_PRIVATE_KEY` / `FIREBASE_CLIENT_EMAIL` env vars — those are from an older config.

In the default `AUTH_MODE=local`, Firebase init is skipped entirely and no credentials are read.

## Auth

`AUTH_MODE=local` (default in `docker-compose.yml`) uses locally-signed JWTs and password hashes in the Postgres `users` table — fully offline, no Firebase. Admin accounts are created by the admin API/UI or CLI, not open signup. `AUTH_MODE=firebase` keeps the legacy Firebase ID-token path.

All endpoints except `/health` require `Authorization: Bearer <token>`. Backend validates via `get_current_user_id` dependency. Multi-tenant: `userId` in URL path must match token's `uid`. Tokens for deleted users are rejected on every request.

## Key Architecture

- **Routes → Services → External APIs** pattern (no direct DB/external calls from routes)
- **Vision extraction is Gemini-only** — DeepSeek's chat API is text-only, cannot process images. The `extract_receipt_data` and `extract_receipt_batch` functions in `backend/app/services/gemini.py` always require Gemini.
- **Local auth is server-only** — `app/services/auth_service.py` (bcrypt + HS256 JWTs) + `app/api/auth.py` (`/api/v1/auth/login`, `/auth/me`, admin `/auth/admin/users`). Offline auth; AI providers still need internet.
- **Scan session state lives in Postgres** — durable `scan_sessions`/`scan_session_items` (prep → hold → manual dispatch). Redis is only the Celery broker + small caches.
- **Celery worker** for async batch extraction (`tasks.worker`)
- **vite.config.ts** proxies `/api` → `localhost:5000` for local dev (Docker uses Nginx instead)

## Commands

### Backend (local)

```bash
cd backend
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

### Frontend (local)

```bash
cd frontend
npm install
npm run dev       # :5173 with proxy
npm run build     # tsc + vite build  (also serves as typecheck)
npm run lint      # eslint
```

## Testing

### Backend (in-container pytest)

Uses the dedicated `scanapp_test` database (auto-created + migrated). Tests are baked into the image; run them on the running backend container:

```bash
docker exec -u 0:0 -w /app scan-app-backend env TEST_DATABASE_URL=postgresql://scanapp:scanapp_dev@postgres:5432/scanapp_test IMAGE_STORAGE_DIR=/tmp/scanapp_pytest_images BACKUP_STORAGE_DIR=/tmp/scanapp_pytest_backups python -m pytest tests -v
```

The suite requires `AUTH_MODE=local` and a writable test DB; `conftest.py` forces deterministic env (admin@pytest.local, scratch storage dirs) so it works regardless of compose vars. No Redis/Celery needed — the batch engine is driven directly with a mocked AI provider.

⚠️ **Never run the suite without the `IMAGE_STORAGE_DIR`/`BACKUP_STORAGE_DIR` overrides.** The container env sets them to the production volumes; conftest's scratch-dir sandbox is a *forced* override, so passing the env explicitly is the safety net. A suite run against the real `image_data` volume with the empty test DB as reference set can delete live receipts' image files.

Manual testing via Swagger UI (`/docs`) and curl. Frontend testing via browser DevTools.

## Postgres Collation Auto-Fix (one-shot)

Clusters initdb'd by the old `postgres:16-alpine` (musl) image carry `datcollate=en_US.utf8`,
which musl treated as byte-order (like C). Served by glibc postgres, that SAME datcollate is a
real locale — so every btree index on a text column silently disagrees with query-time
collation: **index lookups return 0 rows while the rows exist**, and the app 401s everything
with "User no longer exists" (`get_user_by_uid` misses through the unique index).

The `postgres-collation-fix` one-shot service (build `docker/postgres`, `Dockerfile.fix` +
`collation_fix.sh`) runs BEFORE postgres (`depends_on: service_completed_successfully`, requires
**Compose v2**). On every boot it checks `datcollate`; for a non-`C.UTF-8` cluster it:

1. dumps the DB (custom format, `--exit-on-error` restore later)
2. snapshots the old data dir to the **pgdata-old volume** (`/fix/old/pre_collation_fix`)
3. initdb's a fresh `C.UTF-8` cluster, restores the dump, verifies, writes `.collation_fixed`

Nothing is deleted: old cluster snapshot + dump + log live in `pgdata-old` and
`collation-fix-backups` volumes. Any failure exits non-zero → `docker compose up` aborts before
postgres boots on partial data. Idempotent: healthy `C.UTF-8` clusters skip in ~1s. A failed
run leaves a guard that refuses to auto-continue until the operator restores the snapshot.

```bash
docker compose logs -f postgres-collation-fix   # what it did / skipped
docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SHOW lc_collate"
```

- Opt out on an install: `POSTGRES_COLLATION_FIX_DISABLED=1` in `.env` (not recommended).
- Rollback: stop postgres, `docker compose exec` a `postgres:16` one-shot to
  `cp -a /fix/old/pre_collation_fix/. /var/lib/postgresql/data/` (mount both volumes), then
  remove the marker (`rm /fix-backups/.collation_fixed` on the `collation-fix-backups`
  volume) and `docker compose rm -f postgres-collation-fix && docker compose up -d postgres`.
- Backend also logs a boot-time `logger.warning` if the connected DB's `datcollate` isn't
  byte-order — the last line of defense on installs that skipped/disabled the fix.

## System Backups (Wal-G + pg_dump + images)

Whole-cluster backups run automatically from the `backup` sidecar (build `./backup`,
cron inside). See `ops/restore/README.md` for the full runbook.

```bash
docker compose logs -f backup                 # job logs + schedule
docker compose exec backup /opt/backup/full.sh          # manual: ONE process = Wal-G base + pg_dump + images tarball + combined manifest + retention (reports COMPLETE only when both DB and images succeeded)
docker compose exec backup /opt/backup/images.sh        # manual: images-only ad-hoc archive
docker compose exec backup /opt/backup/verify.sh        # weekly: restore dump to scratch DB + decrypt/integrity-check images archive
docker compose exec backup wal-g backup-list            # base backups in store
ops/restore/restore.sh --latest               # full restore to scratch container + PITR with --time
```

- Store: `backup_data` volume → `system_backups/{wal,dumps,images,keys,manifests}`,
  **encrypted** (Wal-G/libo sodium + GPG-AES256 for dumps AND images; key
  auto-generated on first sidecar boot, never in git/env).
- The nightly `full.sh` job is a single process covering the whole system: a
  full backup only reports COMPLETE when DB (wal-g base + pg_dump) AND images
  (encrypted tarball) both succeeded; one combined manifest per run pairs them.
- Postgres runs the custom `scan-app-postgres-walg:16` image (Debian `postgres:16`,
  not -alpine — the Wal-G release binary is glibc) with `archive_mode=on` +
  `archive_command=wal-g wal-push %p` → PITR with ~seconds RPO.
- Wal-G physical backup is **local-mode**: `wal-g backup-push /var/lib/postgresql/data`
  (pgdata mounted `:ro` into the backup container) — remote backup-push is broken on
  PG ≥ 15.
- Manifests record `alembic_version`; restore compares against repo head (forward
  migrations safe, rollback blocked).
- Retention: `BACKUP_RETAIN_FULL` (default 7) Wal-G bases, `BACKUP_RETAIN_DUMPS`
  (default 14) dumps+images+manifests.

## Gotchas

- `npm run build` is the typecheck command (runs `tsc && vite build`); note `tsc`
  alone is a no-op on the solution-style tsconfig — real checks are `npx tsc -b`
  and `npx eslint src` (flat config `eslint.config.js`, ESLint 9)
- Postgres uses `C.UTF-8` collation (byte-order). Do NOT initdb with en_US.UTF-8:
  glibc sorts lowercase-first and silently breaks text comparisons (e.g. the
  `conversations.chk_pair_ordered` check) that were built/tested under byte order
- Backend tests are pytest (in-container), not jest — see Testing above
- Scan sessions are durable in Postgres — a `prepared` session survives restarts and is dispatched manually; Redis is only the Celery broker and non-scan caches (ephemeral)
- Frontend `VITE_*` vars are build-time only; changing `.env` requires rebuild
- HEIC images are converted server-side by `pillow-heif` in `image_service.py`
- Single `/extract` is synchronous; `/batch-extract` is async via Celery + task polling
- Bootstrap admin creds: `ADMIN_EMAIL`/`ADMIN_PASSWORD` env (compose defaults `admin@local`/`admin12345`); when unset, a random admin is generated and logged once at boot
- **Never wipe the image volume.** Receipt rows (pgdata volume) store only
  `image_filename` names; the image bytes live in the separate `image_data`
  volume (`/app/data/images`). `docker compose down -v`, `docker system prune
  --volumes` (while the stack is down), or deleting volume contents in
  Portainer wipes the files while the DB keeps referencing them → every
  gallery image 404s. `docker compose down` + `up --build` alone is safe.
  The backend warns at boot: "IMAGE INTEGRITY: N of M receipt image files
  ... missing". Recover from backup exports with
  `docker exec scan-app-backend python scripts/restore_images_from_backup.py /path/backup.tar.gz [...]`
  (extracts only DB-referenced files; idempotent).
