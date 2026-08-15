# Critical Issues & Security Concerns

Last reviewed: 2026-08-15. Every item below was verified against the current codebase
(main.py, database.py, config.py, security.py, docker-compose.yml, frontend/nginx.conf).
Firebase is legacy (`AUTH_MODE=local` is the default), scan session state is durable
Postgres, and all configuration is centralized in the repo-root `.env` file (the compose
file and backend contain no hardcoded operational values).

---

## ✅ Resolved since this doc was last written

| ID | Item | How it was resolved |
|----|------|---------------------|
| S1 | SECRET_KEY default not enforced | `main.py` raises `RuntimeError` at startup when `SECRET_KEY` is **missing or empty** or equals `change-me-in-production` |
| S2 | API keys stored plaintext | `encryption.py` encrypts on write (Fernet, key derived from SECRET_KEY) and decrypts on read; legacy plaintext auto-encrypts on next save |
| S4 | Default admin password | `main.py` refuses to boot in local mode with `ADMIN_PASSWORD` empty, `admin12345`, or the template placeholder |
| S5 | Backups leaked plaintext API keys | `backup_service.py` redacts `configs[].api_key` as `[REDACTED]` on export |
| S6 | Redis had no auth | compose requires `REDIS_PASSWORD`; `REDIS_URL` carries the password |
| S7 | Postgres published on `0.0.0.0:5432` | Compose now binds `127.0.0.1:5432:5432` (host-local only); backend/worker use `data-network` |
| S8 | RLS coverage gaps | `scan_session_items` got a `user_id` column + backfill (migration 007); `user_ai_settings` and `scan_session_items` added to the RLS table list |
| S9 | Frontend `network_mode: host` | Frontend moved to the `app-network` bridge; published `8081:8081`; nginx upstream → `backend:8000` |
| S10 | `firebaseservice.json` mounted in local mode | Mount removed from backend + worker (unused in `AUTH_MODE=local`) |
| T1 | No Row-Level Security | `database.py` enables RLS + `user_isolation` policy on all user-data tables (incl. `scan_session_items`, `user_ai_settings`) |
| T2 | Manual per-route userId checks | `security.validate_user_access` — shared dependency that validates URL `userId` == token uid |
| T3 | No logging of cross-tenant attempts | `validate_user_access` logs a `SECURITY:` warning with user/IP/endpoint on 403 |
| N3 | Nginx leaked Server header | `proxy_hide_header Server` configured |
| N4 | SSRF in image proxy | `images.py` blocks RFC1918/link-local/loopback ranges + a blocked-hostname list |
| N5 | No rate limiting | nginx `limit_req` zones: `api` 10 r/s, `extract` 2 r/s, backups/batch with burst |
| A2 | No CSP | `Content-Security-Policy` added on all nginx responses (caveat: `unsafe-inline`, see open #9) |
| A3 | Uploads trusted Content-Type | `image_service.py` detects format from magic bytes and ignores the client header |
| A6 | Swagger exposed | compose sets `ENABLE_DOCS: "false"` (env-driven now) |
| C1 | Backend/worker ran as root | backend `Dockerfile` ends with `USER appuser`; entrypoint drops via `runuser` (frontend still root — open #7) |
| C2 | Writable code mounts | app code is baked into images; only `/app/data*` and `/app/backups` are writable mounts |
| D1 | No backup capability | backup API + `backup_data` volume exist (no schedule — open #10) |
| D3 | Image orphans on failure | upload path removes temp files on exception |
| E1 | Config scattered across code/yml | All operational values centralized in `.env` (`.env.example` is the template); compose + `config.py` read everything from it; secrets fail fast when missing (`${VAR:?}`) |
| — | Firebase everywhere | `AUTH_MODE=local` (Postgres users + JWT) is the default; Firebase init is skipped entirely |

---

## 🔴 Open — Critical

| # | Concern | Current State | Recommendation |
|---|---------|---------------|----------------|
| 1 | **No HTTPS/TLS** | Frontend `:8081` + API `:8003` are plaintext on the LAN. | Terminate TLS (Caddy/nginx/certbot, or Tailscale TLS) before internet exposure. |

---

## 🟠 Open — High

| # | Concern | Current State | Recommendation |
|---|---------|---------------|----------------|
| 2 | **Legacy plaintext API keys still at rest** | New writes are encrypted, but keys written before encryption remain plaintext in `user_ai_settings.configs` until each user rewrites them. | One-shot migration that loads each `configs` blob and re-saves via `encrypt_api_key()`. |

---

## 🟡 Open — Medium

| # | Concern | Current State | Recommendation |
|---|---------|---------------|----------------|
| 3 | **Frontend Nginx runs as root** | `frontend/Dockerfile` has no `USER`; `nginx -g "daemon off"` as root. | Add `USER nginx` (nginx:alpine provides it) + writable `/var/cache/nginx`. |
| 4 | **No hostname validation in nginx** | `server_name` unset; default-server `return 444` block commented out. | Restrict `server_name` and re-enable default-server reject for DNS-rebinding defense. |
| 5 | **CSP allows `unsafe-inline` scripts** | `script-src 'self' 'unsafe-inline'`. | Move inline scripts/styles out; drop `'unsafe-inline'`. |
| 6 | **No automated backups** | Backup API + volume exist but nothing schedules `pg_dump`/export. | Add cron/sidecar (pg_dump + backup export to external storage). |
| 7 | **Redis default password possible** | `.env.example` prefills `redis_dev`; fine on host-local setups. | Set a strong `REDIS_PASSWORD`; consider `rediss://`. |

---

## 🟢 Open — Low

| # | Concern | Current State | Recommendation |
|---|---------|---------------|----------------|
| 8 | Rate limits are per-IP | `limit_req_zone $binary_remote_addr`. | Add token-based limiting for authenticated endpoints. |
| 9 | No CPU/memory limits | Redis sets `--maxmemory` only. | Add compose `mem_limit`/`cpus`. |
| 10 | Alembic downgrade untested | `downgrade()` exists but unexercised. | Test on a staging DB. |

---

## RLS coverage matrix

| Table | user_id col | RLS enabled |
|-------|-------------|-------------|
| receipts | ✅ | ✅ |
| tasks | ✅ | ✅ |
| review_batches | ✅ | ✅ |
| audit_logs | ✅ | ✅ |
| scan_errors | ✅ | ✅ |
| scan_sessions | ✅ | ✅ |
| scan_session_items | ✅ (007) | ✅ |
| user_ai_settings | ✅ | ✅ |
| users | ✅ | (admin-managed — intentionally not RLS'd) |

---

## Priority action items (ordered)

1. **🔴 Add TLS / reverse proxy** for any internet-exposed deployment.
2. **🟠 One-shot migration to encrypt legacy API keys.**
3. **🟡 Non-root frontend nginx** — `USER nginx`.
4. **🟡 Nginx hostname validation** — `server_name` + default-server `444`.
5. **🟡 Scheduled backups** — cron/pg_dump to external storage.
6. **🟡 Tighten CSP** — remove `'unsafe-inline'` from `script-src`.