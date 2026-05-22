# AGENTS.md

## Stack

React 19 (Vite + TypeScript + Tailwind) → Nginx → FastAPI (Python) → Firebase (Auth, Firestore, Storage) + Gemini API
Redis + Celery for async batch processing.

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

Backend uses a **service account JSON file** mounted at `/app/firebaseservice.json` (from `./firebaseservice.json` in repo root). Set via `FIREBASE_CREDENTIALS_PATH`. **Do not** use individual `FIREBASE_PRIVATE_KEY` / `FIREBASE_CLIENT_EMAIL` env vars — those are from an older config.

Frontend uses `VITE_FIREBASE_*` build args (baked at build time, not runtime).

## Auth

All endpoints except `/health` require `Authorization: Bearer <firebase_token>`. Backend validates via `get_current_user_id` dependency. Multi-tenant: `userId` in URL path must match token's `uid`.

## Key Architecture

- **Routes → Services → External APIs** pattern (no direct DB/external calls from routes)
- **Vision extraction is Gemini-only** — DeepSeek's chat API is text-only, cannot process images. The `extract_receipt_data` and `extract_receipt_batch` functions in `backend/app/services/gemini.py` always require Gemini.
- **Batch state lives in Redis** (TTL-bound, lost on restart → batches auto-fail)
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

No test framework. Manual testing via Swagger UI (`/docs`) and curl. Frontend testing via browser DevTools.

## Gotchas

- `npm run build` is the typecheck command (runs `tsc && vite build`)
- No `pytest` or jest — all testing is manual via Swagger UI
- Redis data is ephemeral (TTL set in `batch_service.py`) — server restart kills in-progress batches
- Frontend `VITE_*` vars are build-time only; changing `.env` requires rebuild
- HEIC images are converted server-side by `pillow-heif` in `image_service.py`
- Single `/extract` is synchronous; `/batch-extract` is async via Celery + task polling
