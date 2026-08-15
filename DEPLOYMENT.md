# Deployment Guide

This app is a **multi-tenant web app** (React + FastAPI + PostgreSQL + Celery/Redis), not a
desktop program. Pick the model that fits:

| Model | What the user does | Your job ("feeding updates") | Best for |
|---|---|---|---|
| **A. Hosted (SaaS)** — recommended | Opens a URL in their browser, logs in. Nothing to install. | Pull code, rebuild images, restart, migrate on **your** server. Users get updates automatically. | Most users, least friction, matches the multi-tenant design (admin creates users, per-user JWT, RLS). |
| **B. Per-user Docker hosting** | Installs Docker, clones/pulls, edits `.env`, runs `docker compose up`. | Publish new images (or give a tarball/diff); each user pulls + restarts + runs migrations. | One-off/customers who demand their own data, or offline networks. |
| **C. Desktop app** | Downloads a program. | — | **Not recommended.** Would require bundling Postgres+Redis+Celery or reworking to SQLite, a major rearchitecture. |

> This document assumes **Model A** (one server you control) but Section 6 covers the
> per-user Docker route and what cloning elsewhere actually entails.

---

## 1. System requirements

- A Linux server (or any Docker host) with **Docker** and **Docker Compose v2**.
- ~2 GB RAM minimum (Postgres + Redis + backend + worker), **2 vCPU+** recommended.
- ~10 GB free disk (images: app ~2 GB, built images ~3–4 GB, plus stored receipt images).
- Internet access for AI providers (Gemini / DashScope / DeepSeek / OpenRouter). Login and
  CRUD work fully offline (local auth); only AI scanning needs internet.
- 2 open ports: **8081** (web UI) and **8003** (API). PostgreSQL 5432 should **not** be
  exposed publicly (see Security).

---

## 2. What you get in one stack (`docker-compose.yml`)

| Service | Image | Notes |
|---|---|---|
| `frontend` | built from `./frontend`, Nginx | serves the React app on **:8081**, `network_mode: host` |
| `backend` | built from `./backend` | FastAPI on **:8003** → 8000, health at `/health` |
| `worker` | same backend image | Celery, async batch extraction |
| `postgres` | `postgres:16` | database `scanapp`, published on **:5432** |
| `redis` | `redis:7` | Celery broker + caches only (scan sessions are durable in PG) |

All persistent data lives in named volumes: `pgdata`, `image_data`, `review_batch_data`,
`backup_data`. Stopping/rebuilding containers never loses data.

---

## 3. Fresh install (clone to a new machine)

```bash
# 1. Clone
git clone <your-repo-url> scan_app
cd scan_app

# 2. Create local env from the template, then change ONLY the REQUIRED values
cp .env.example .env
nano .env
```

### 3.1 `.env` — minimal setup

Everything lives in `.env` (single source of truth — nothing is hardcoded in the
compose file or the backend). Non-secret values come prefilled with working
defaults; **only the REQUIRED section needs your attention**:

| Variable | Note |
|---|---|
| `SECRET_KEY` | **Required to change.** `python3 -c "import secrets;print(secrets.token_urlsafe(32))"`. Never rotate it later. |
| `ADMIN_PASSWORD` | **Required to change.** First admin login. |
| `GEMINI_API_KEY` | Set if you want AI scanning (seeded once as the admin Gemini key). |
| `DB_PASSWORD` / `REDIS_PASSWORD` / `ADMIN_EMAIL` | Prefilled defaults — strengthen if exposing beyond your machine. |

The backend **refuses to boot** with `SECRET_KEY=change-me-in-production` or
`ADMIN_PASSWORD=admin12345` (and compose aborts if any secret var is missing),
so a lazily copied template fails fast instead of running insecure.

### 3.2 One command on a fresh machine

Migrations run **automatically** at backend startup (`RUN_MIGRATIONS=true`), so a
fresh clone needs no manual schema step:

```bash
# 1. Clone
git clone <your-repo-url> scan_app
cd scan_app

# 2. Env — change ONLY the REQUIRED values
cp .env.example .env
nano .env          # SECRET_KEY + ADMIN_PASSWORD (+ GEMINI_API_KEY for AI)

# 3. Build and start everything — the backend auto-migrates on first boot
docker compose up -d --build

# 4. Verify
docker compose ps            # all 5 services up, backend healthy
curl http://localhost:8003/health
# open http://localhost:8081 in a browser
```

The backend waits for Postgres/Redis to be healthy, applies any pending
`alembic upgrade head`, then starts. `RUN_MIGRATIONS=false` restores the manual
flow (`docker compose run --rm backend alembic upgrade head`).

Postgres is bound to `127.0.0.1:5432` (host-local only — never published to the
LAN); the frontend listens on `0.0.0.0:8081`, the API on `0.0.0.0:8003`.

If your host already runs Postgres/Redis or uses ports 8081/8003/5432, edit the ports in
`docker-compose.yml`.

---

## 4. First login and users

1. Log in with `ADMIN_EMAIL`/`ADMIN_PASSWORD` at `http://localhost:8081`.
2. Create users from the **Admin** page (admin-only). This is the intended flow — there is
   no open signup.
3. CLI alternative (inside the backend container):
   ```bash
   docker compose exec backend python scripts/create_user.py user@example.com 'password123'
   docker compose exec backend python scripts/create_user.py boss@example.com 'pw' --admin --name "Boss"
   ```

## 5. Connecting AI providers

Each user (or the admin for a shared key) picks a provider and model in **AI Scanning Engine**
settings, pastes a key, clicks **Test Connection**, then **Apply**.

- **Admin shared keys** (admin → AI Providers): used only by users who did **not** set their
  own key. A user's own key always wins.
- **Model caveats**: models known to return poor structured output (e.g. `qwen-vl-ocr`) show
  an amber warning in the UI. Missing/empty fields still land in `needs_review`.
- Reminder: scanning requires internet to the AI provider; everything else works offline.

---

## 6. Updating the app (your "feed updates" job)

```bash
cd scan_app
git pull                                       # or pull the published images

# Build the changed images (code is baked in — no live-reload in containers)
docker compose build backend worker frontend

# Migrations are applied automatically at backend startup (RUN_MIGRATIONS=true).
# Only if you disabled that, apply them manually first:
#   ls backend/alembic/versions/*.py   # new files = new migrations
#   docker compose run --rm backend alembic upgrade head

# Restart
docker compose up -d backend worker frontend
docker compose ps
```

Users on a hosted instance see the new version on their next page load — no action needed.

---

## 7. Common issues on a fresh clone / new machine

| Symptom | Cause / fix |
|---|---|
| Backend crash-loops at boot | Schema missing (e.g. `relation "users" does not exist`) → auto-migration runs at startup; if disabled, run `docker compose run --rm backend alembic upgrade head`. |
| `ModuleNotFoundError: name 'asyncio'` in worker | Worker running a stale image → rebuild (`docker compose build worker`). |
| UI features unchanged after a code change | Nginx serves the built bundle → rebuild `frontend`. |
| Port already in use | Edit compose ports; prefer binding 5432 to 127.0.0.1. |
| Scan has no AI or fails | No API key configured for the user's provider; or no internet to the AI provider. |
| Tokens stop working / keys fail to decrypt | `SECRET_KEY` changed — it must stay stable. |
| Login fails | Wrong `ADMIN_EMAIL`/`ADMIN_PASSWORD`, or admin was bootstrapped previously with different values (change via admin UI/CLI, not env). |
| HEIC won't open | Backend image must have `pillow-heif` (it's baked in — rebuild backend if old). |

## 8. Security checklist (do these before exposing to the internet)

- Change `ADMIN_PASSWORD` and `DB_PASSWORD`/`REDIS_PASSWORD` defaults.
- Put a real `SECRET_KEY` in `.env`.
- Postgres is already bound to `127.0.0.1:5432` (host-local only).
- Put Nginx/Caddy behind **TLS** (HTTPS), proxy `:8081`/`:8003`, and only expose the frontend port.
- Restrict the SQL `users`/`user_ai_settings` access and keep RLS policies (enabled at pool init).
- Set `ENABLE_DOCS=false` in `.env` for production.
- Back up the named volumes (`pgdata`, `image_data`) regularly.

## 9. Backups

```bash
# Postgres dump (inside the backend container or host):
docker compose exec postgres pg_dump -U scanapp scanapp > backup.sql
# Images + volumes live under the named volumes; snapshot the volume or the host dir.
```

---

## 10. Troubleshooting cheatsheet

```bash
docker compose ps                  # health
docker compose logs -f backend     # API logs
docker compose logs -f worker      # async batch logs
docker compose exec backend bash   # shell (backend image only)
curl http://localhost:8003/health  # health check
# Backend tests (in-container):
docker exec -u 0:0 -w /app scan-app-backend env \
  TEST_DATABASE_URL=postgresql://scanapp:<dbpass>@postgres:5432/scanapp_test \
  python -m pytest tests -q
```