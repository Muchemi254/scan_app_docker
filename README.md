# Scan App

Receipt scanning and management application. Upload receipt images, extract structured
data with Gemini, review/manage receipts, and export reports.

**Stack**: React 19 (Vite + TypeScript + Tailwind) → Nginx → FastAPI (Python) → PostgreSQL (auth + data) · Redis + Celery for async batch processing · Gemini API for AI extraction. Offline local auth (bcrypt + JWT) by default; Firebase is legacy (`AUTH_MODE=firebase`).

## Architecture

```
React Frontend (Vite, :8081 via Nginx)
   │  /api/* proxied
   ▼
Nginx (static SPA + reverse proxy)
   ▼
FastAPI Backend (:8003 → container :8000)
   ├── PostgreSQL  — receipts, users (local auth), audit, scan_sessions, settings
   ├── Redis       — Celery broker + small caches (NOT scan state)
   ├── Celery      — async batch AI extraction worker
   └── Gemini API  — vision extraction (supplier/date/items/amounts)
```

All requests require `Authorization: Bearer <token>`. Multi-tenant — the `userId` in
URL paths must match the token's `uid`. Only exceptions are `/health` and `/docs`.

## Quick Start

```bash
cp .env.example .env       # fill ADMIN_EMAIL, ADMIN_PASSWORD, GEMINI_API_KEY, SECRET_KEY
docker-compose up -d
docker-compose ps          # all services healthy
```

| Service  | URL                          |
|----------|------------------------------|
| Frontend | http://localhost:8081        |
| Backend  | http://localhost:8003        |
| API docs | http://localhost:8003/docs   |
| Health   | http://localhost:8003/health |

Bootstrap admin: `ADMIN_EMAIL`/`ADMIN_PASSWORD` (compose defaults `admin@local` / `admin12345`).
The backend refuses to start while `SECRET_KEY` is the default value.

## Authentication

`AUTH_MODE=local` (default) is fully offline: bcrypt password hashes + locally-signed HS256
JWTs stored in the Postgres `users` table. Admin accounts are created via the admin UI/API,
not open signup.

```bash
# login
curl -X POST :8003/api/v1/auth/login -H "Content-Type: application/json" \
  -d '{"email":"admin@local","password":"admin12345"}'
# → { access_token, user: { uid, email, is_admin } }
```

Use the token for every other call:
```bash
curl -H "Authorization: Bearer <token>" :8003/api/v1/users/<uid>/receipts
```

Admin routes (`/api/v1/auth/admin/*`): create/list/delete users, manage trusted hosts and
AI providers.

## Key Endpoints

All under `/api/v1/users/{userId}/`:

- **Receipts** — `POST /receipts/extract` (single, synchronous), `POST /receipts` (create),
  `GET/PUT/DELETE /receipts/{id}`, `POST /receipts/search` (Postgres full-text),
  `POST /receipts/summary` (AI spending report)
- **Scan sessions** — see flow below: `POST /batches`, `POST /batches/{batchId}/process`,
  `POST /batches/{batchId}/dispatch`, `GET /batches`, `GET /batches/{batchId}`,
  `POST /batches/{batchId}/chunks/{chunkIndex}/retry`, `POST .../items/{itemIndex}/retry`,
  `DELETE /batches/{batchId}`
- Other: dashboard analytics, exports, data cleaning, review batches, scan errors, backups,
  user/global settings, task progress, image proxy (HEIC→JPEG).

### Scan session flow (prep → hold → dispatch)

Local upload + optimization ends in a durable **`prepared`** holding state — nothing is sent
to AI automatically. You then explicitly dispatch groups/items/all:

1. `POST /batches` with filenames → session created (`uploading`)
2. `POST /batches/{batchId}/process` with the image files → images optimized locally,
   deduped against already-extracted receipts, held as `prepared`
3. `POST /batches/{batchId}/dispatch` `{groups:[n]}` or `{items:[...]}` or `{all:true}` →
   exactly those `prepared` items go to the Celery worker (Gemini)
4. Poll `GET /batches/{batchId}` for per-item progress (`pending → extracting → done`)

Sessions (and their items) live in Postgres — a held `prepared` session survives restarts
and can be dispatched days or weeks later without re-uploading. Images auto-group into
chunks of 50 when a session exceeds 50 prepared images. Redis is not used for scan state;
it is only the Celery broker and small caches.

## Docker Commands

```bash
docker-compose up -d              # start all services
docker-compose logs -f backend    # FastAPI logs
docker-compose logs -f frontend   # Nginx logs
docker-compose exec backend bash  # shell into backend
docker-compose build --no-cache   # rebuild after dep changes
docker-compose ps                 # health check
```

Rebuilds are required after backend/frontend code changes — the app code is baked into the
images (no volume mounts).

## Development (local, no Docker)

```bash
# Backend
cd backend && python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000

# Frontend
cd frontend && npm install && npm run dev   # :5173, proxies /api → localhost:5000
```

## Testing

Backend is pytest (in-container, uses the dedicated `scanapp_test` DB — auto-created and
migrated; the suite needs `AUTH_MODE=local`):

```bash
docker exec -u 0:0 -w /app scan-app-backend \
  env TEST_DATABASE_URL=postgresql://scanapp:scanapp_dev@postgres:5432/scanapp_test \
  python -m pytest tests -v
```

Frontend typecheck is `npm run build` (runs `tsc && vite build`).

## Configuration

- `AUTH_MODE` – `local` (default) or legacy `firebase`
- `SECRET_KEY` – JWT signing key; startup fails if it's the default
- `GEMINI_API_KEY` – seeded once as the admin Gemini key (managed per-provider via admin UI)
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` – bootstrap admin credentials
- `DATABASE_URL`, `REDIS_URL` – Postgres / Redis connections
- Frontend `VITE_*` vars are build-time only — changing `.env` requires an image rebuild

## Gotchas

- `npm run build` is the typecheck command; `npm run lint` currently has no config (pre-existing)
- Backend tests are pytest (in-container), not jest
- Vision extraction is Gemini-only — DeepSeek's chat API cannot process images
- HEIC images are converted server-side by `pillow-heif`
- Single `/extract` is synchronous; batch extraction is async via Celery + task polling