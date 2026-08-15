# Critical Issues & Security Concerns

Last reviewed: 2026-08-14. Every item below was verified against the current codebase
(main.py, database.py, security.py, image_service.py, batches.py, docker-compose.yml,
frontend/nginx.conf). Firebase is now legacy (`AUTH_MODE=local` is the default), and scan
session state is durable Postgres — the old "Redis live scans" section is gone.

---

## ✅ Resolved since this doc was last written

| ID | Item | How it was resolved |
|----|------|---------------------|
| S1 | SECRET_KEY default not enforced | `main.py` raises `RuntimeError` at startup when `SECRET_KEY == "change-me-in-production"` (see open #5 for the empty-key gap) |
| S2 | API keys stored plaintext | `encryption.py` encrypts on write (Fernet, key derived from SECRET_KEY) and decrypts on read; legacy plaintext auto-encrypts on next save |
| S5 | Backups leaked plaintext API keys | `backup_service.py` redacts `configs[].api_key` as `[REDACTED]` on export |
| S6 | Redis had no auth | compose runs `redis-server --requirepass` and `REDIS_URL` carries the password |
| T1 | No Row-Level Security | `database.py` enables RLS + `user_isolation` policy on user-data tables (see open #3 for coverage gaps) |
| T2 | Manual per-route userId checks | `security.validate_user_access` — shared dependency that validates URL `userId` == token uid |
| T3 | No logging of cross-tenant attempts | `validate_user_access` logs a `SECURITY:` warning with user/IP/endpoint on 403 |
| N3 | Nginx leaked Server header | `proxy_hide_header Server` configured |
| N4 | SSRF in image proxy | `images.py` blocks RFC1918/link-local/loopback ranges + a blocked-hostname list |
| N5 | No rate limiting | nginx `limit_req` zones: `api` 10 r/s, `extract` 2 r/s, backups/batch with burst |
| A2 | No CSP | `Content-Security-Policy` added on all nginx responses (caveat: `unsafe-inline`, see open #9) |
| A3 | Uploads trusted Content-Type | `image_service.py` detects format from magic bytes and ignores the client header |
| A4 | No request correlation | `main.py` adds `X-Request-ID` middleware |
| A6 | Swagger exposed | compose sets `ENABLE_DOCS: "false"` |
| C1 | Backend/worker ran as root | backend `Dockerfile` ends with `USER appuser`; entrypoint drops via `runuser` (frontend still root — open #7) |
| C2 | Writable code mounts | app code is baked into images; only `/app/data*` and `/app/backups` are writable mounts |
| D1 | No backup capability | backup API + `backup_data` volume exist (no schedule — open #10) |
| D3 | Image orphans on failure | upload path removes temp files on exception |
| — | Firebase everywhere | `AUTH_MODE=local` (Postgres users + JWT) is the default; Firebase init is skipped entirely |

---

## 🔴 Open — Critical

| # | Concern | Current State (verified) | Recommendation |
|---|---------|--------------------------|----------------|
| 1 | **No HTTPS/TLS** | Frontend `network_mode: host` listening on `:8081`; backend on `:8003`. Everything plaintext on the LAN. | Terminate TLS (Caddy/nginx/certbot, or Tailscale TLS). Move frontend off `network_mode: host` onto the bridge network. |
| 2 | **Postgres published to the host** | `docker-compose.yml` publishes `5432:5432` to `0.0.0.0` with default password `scanapp_dev` (`.env` does not set `DB_PASSWORD`). Anyone on the LAN can connect as `scanapp`. | Remove the `ports:` mapping (backend/worker reach it via `data-network`); set a real `DB_PASSWORD`. |
| 3 | **RLS coverage gaps** | `_enable_rls` covers `receipts, tasks, review_batches, audit_logs, scan_errors, scan_sessions`. **Missing: `user_ai_settings`** (user-owned, contains API keys) and `scan_session_items` (child rows keyed by `session_id` only, no `user_id` column). | Add `user_ai_settings` to the RLS list; for `scan_session_items`, add a `user_id` column (or enforce via session join) so a direct-connection query can't read another user's session items. |
| 4 | **Default admin password** | `ADMIN_PASSWORD` unset → compose default `admin12345`; frontend is LAN-reachable. | Require `ADMIN_PASSWORD` in `.env`; refuse to boot with the default (mirror the SECRET_KEY check). |

---

## 🟠 Open — High

| # | Concern | Current State (verified) | Recommendation |
|---|---------|--------------------------|----------------|
| 5 | **SECRET_KEY empty value passes the guard** | `main.py` only rejects the literal default string. If `SECRET_KEY` is unset/empty, compose injects `""` → JWT HMAC uses an empty key and startup succeeds. | Reject empty/missing SECRET_KEY too (`if not settings.SECRET_KEY or settings.SECRET_KEY == "change-me-in-production"`). |
| 6 | **Legacy plaintext API keys still at rest** | New writes are encrypted, but keys written before encryption remain plaintext in `user_ai_settings.configs` until each user rewrites them. | Run a one-shot migration that loads each `configs` blob and re-saves it via `encrypt_api_key()`. |

---

## 🟡 Open — Medium

| # | Concern | Current State (verified) | Recommendation |
|---|---------|--------------------------|----------------|
| 7 | **Frontend Nginx runs as root** | `frontend/Dockerfile` has no `USER`; `nginx -g "daemon off"` as root. | Add `USER nginx` (nginx:alpine provides it) and make `/var/cache/nginx` writable. |
| 8 | **No hostname validation in nginx** | `server_name localhost` is commented out; the default-server `return 444` block is commented out ("re-enable for production"). | Restrict `server_name` and re-enable the default-server reject to stop DNS rebinding. |
| 9 | **CSP allows `unsafe-inline` scripts** | `script-src 'self' 'unsafe-inline'` — inline script execution weakens XSS defense. | Move inline scripts/styles out; drop `'unsafe-inline'` from `script-src`. |
| 10 | **No automated backups** | Backup API + volume exist but nothing schedules `pg_dump` / export. | Add a cron/sidecar that runs pg_dump + the backup export to external storage. |
| 11 | **Redis default password** | `redis_dev` when `REDIS_PASSWORD` unset (not published externally — low exposure). | Set a real password; consider `rediss://`. |
| 12 | **Frontend uses `network_mode: host`** | Nginx shares the host net namespace — no isolation, LAN-visible. | Move to the `app-network` bridge with a published port. |

---

## 🟢 Open — Low

| # | Concern | Current State (verified) | Recommendation |
|---|---------|--------------------------|----------------|
| 13 | Rate limits are per-IP | `limit_req_zone $binary_remote_addr` — bypassable via multiple IPs. | Add token-based limiting for authenticated endpoints. |
| 14 | No CPU/memory limits | Only Redis sets `--maxmemory`. No `mem_limit`/`cpus` on services. | Add compose resource limits to prevent exhaustion DoS. |
| 15 | Alembic downgrade untested | `downgrade()` exists but has not been exercised. | Test `alembic downgrade` on a staging DB. |
| 16 | `firebaseservice.json` still mounted | Mounted `:ro` into backend + worker, but unused in `AUTH_MODE=local`. | Remove the mount (or guard it behind `AUTH_MODE=firebase`) to shrink the credential surface. |

---

## RLS coverage matrix (as of review)

| Table | user_id col | RLS enabled |
|-------|-------------|-------------|
| receipts | ✅ | ✅ |
| tasks | ✅ | ✅ |
| review_batches | ✅ | ✅ |
| audit_logs | ✅ | ✅ |
| scan_errors | ✅ | ✅ |
| scan_sessions | ✅ | ✅ |
| **user_ai_settings** | ✅ | ❌ **missing** |
| **scan_session_items** | ❌ (session_id only) | ❌ **missing** |
| users | ✅ | (admin-managed — intentionally not RLS'd) |

---

## Priority action items (ordered)

1. **🔴 Reject empty SECRET_KEY** — close the #5 gap in `main.py`.
2. **🔴 Stop publishing Postgres on `0.0.0.0:5432`** — remove the `ports:` mapping, set `DB_PASSWORD`.
3. **🔴 Add TLS / move frontend off host network** — secure the LAN surface.
4. **🔴 Require non-default ADMIN_PASSWORD** — refuse to boot with `admin12345`.
5. **🔴 Close RLS gaps** — add `user_ai_settings`; plan `scan_session_items.user_id`.
6. **🟠 One-shot migration to encrypt legacy API keys**.
7. **🟡 Non-root frontend nginx** — `USER nginx` in `frontend/Dockerfile`.
8. **🟡 Nginx hostname validation** — `server_name` + default-server `444`.
9. **🟡 Scheduled backups** — cron/pg_dump to external storage.
10. **🟡 Tighten CSP** — remove `'unsafe-inline'` from `script-src`.
