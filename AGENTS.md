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
docker exec -u 0:0 -w /app scan-app-backend env TEST_DATABASE_URL=postgresql://scanapp:scanapp_dev@postgres:5432/scanapp_test python -m pytest tests -v
```

The suite requires `AUTH_MODE=local` and a writable test DB; `conftest.py` forces deterministic env (admin@pytest.local) so it works regardless of compose vars. No Redis/Celery needed — the batch engine is driven directly with a mocked AI provider.

Manual testing via Swagger UI (`/docs`) and curl. Frontend testing via browser DevTools.

## Gotchas

- `npm run build` is the typecheck command (runs `tsc && vite build`)
- Backend tests are pytest (in-container), not jest — see Testing above
- Scan sessions are durable in Postgres — a `prepared` session survives restarts and is dispatched manually; Redis is only the Celery broker and non-scan caches (ephemeral)
- Frontend `VITE_*` vars are build-time only; changing `.env` requires rebuild
- HEIC images are converted server-side by `pillow-heif` in `image_service.py`
- Single `/extract` is synchronous; `/batch-extract` is async via Celery + task polling
- Bootstrap admin creds: `ADMIN_EMAIL`/`ADMIN_PASSWORD` env (compose defaults `admin@local`/`admin12345`); when unset, a random admin is generated and logged once at boot
