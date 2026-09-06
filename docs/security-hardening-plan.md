# Security Hardening Plan — ScanApp (`AUTH_MODE=local`)

> Saved 2026-09-06 — revisit before exposing beyond LAN. Owner: revisitable roadmap. Next step gated on TLS target + JWT UX decision (see §9).

## 1. Objective

Make the self-hosted `React 19 → Nginx :8081 → FastAPI :8003 → Postgres (RLS by `users.uid`) → Redis/Celery → Gemini` deployment safe to expose beyond LAN and to satisfy KRA record-keeping + minimal GDPR hygiene without breaking the current 2784-receipt dataset (migrations `022` image mirror, `026` industries). Keep offline `bcrypt+HS256 JWT` flow; add perimeter, credential, and data-layer hardening in reversible steps.

## 2. Current Posture (verified 2026-09-06)

**Solid:** `bcrypt` trunc 72B (`backend/app/services/auth_service.py:35`), JWT `sub=uid,exp+30d,iss=scanapp-local` (`backend/app/services/auth_service.py:48`), revocation via `get_user_by_uid` check (`backend/app/core/security.py:23`), RLS per-connection `set_config('app.current_user_id')` (`backend/app/core/database.py:27`, 10 tables + `conversations.is_participant` `014_messages.py:84`), SSRF blocks private CIDRs/metadata (`backend/app/api/images.py:25`), API-key `Fernet(sha256(SECRET_KEY))` encrypt + masked `********+last4` (`backend/app/core/encryption.py`, `backend/app/api/settings.py:67`, `backend/app/api/auth.py:345`), audit `REPORT_EXPORT` always logged (`backend/app/services/reports_service.py:578`), secrets fail-closed `SECRET_KEY:?` (`docker-compose.yml:172`, `backend/app/main.py:49`), `trusted_hosts` middleware (`backend/app/main.py:303`), Nginx `limit_req zone api 10r/s / extract 2r/s` (`frontend/nginx.conf:8`).

**Open (ranked):**
- **P0 internet:** Plaintext `8081/8003`, no `HSTS`, `ALLOWED_HOSTS=*` default (`backend/app/core/config.py:47` → `trusted_hosts {"*"}` disabled), CSP `unsafe-inline` (`frontend/nginx.conf:45,167`) — `CRITICAL_ISSUES High#3-5`.
- **P0 credential:** `JWT_EXPIRE_DAYS=30` no refresh/`jti`/blacklist, no login lockout/captcha, no 2FA (`grep 2FA` only docs), `AdminCreateUserRequest` no `min 8` on create, rotation invalidates AI keys+JWTs (`.env.example`).
- **P1 secrets at rest:** Legacy rows stay plaintext Fernet until rewrite (no migration), `sha256(SECRET_KEY)` not KDF, backup key `keys/.backup_key` co-located with `backup_data` (no off-site 3-2-1) — `backup/scripts/full.sh`, `docs/system-backup-accessibility.md:8`.
- **P1 data:** Superuser `scanapp` bypasses RLS (real tenant filter is app code), `line_items` not re-RLS'd, `kraPin/buyerKraPin/cuInvoice Optional[str]` freeform no `P/A\d{9,10}[A-Z]` regex, no eTIMS lock, `audit_logs` mutable PG.
- **P1 observability:** `/health` trivial, `health/detailed` swallows `celery ping→ok(idle)`; no metrics/alert on `full.sh` fail, `result_expires 3600` loses history, SSE `?token=` leaks to logs/history (`frontend/src/hooks/useMessageStream.ts:22`).

## 3. Design Principles

- Single-deployment per customer, per-user RLS is source of truth — do not weaken `verify_user_access` / `validate_user_access` (`backend/app/api/receipts.py:56`, `backend/app/core/security.py:118`). RBAC layers on top — security hardening first, roles second.
- Keep `AUTH_MODE=local` offline path intact; Firebase flag stays dead (`AGENTS.md`). No cookie sessions (avoids CSRF), stay `Authorization: Bearer`.
- Any `SECRET_KEY` rotation is breaking — plan versions/key-rotation instead of silent hash.
- `image_data` is cache (`022` mirror) — encryption at rest for images optional; receipt PII encryption not required.

## 4. Phased Plan (execute in order, each verifiable alone)

### Phase 0 — Prep (no behavior change, 30m)
- Inventory settings: freeze `SECRET_KEY, DB_PASSWORD, REDIS_PASSWORD, ALLOWED_HOSTS, CORS_ORIGINS, JWT_EXPIRE_DAYS, ENCRYPTION_KDF` in `.env` + `.env.example` docs.
- Add `SECURITY.md` checklist citing files below.

### Phase 1 — Perimeter (P0, 1 day) — blocks DNS rebinding + plaintext
1. **TLS termination:** Caddy (or Traefik) in front of `frontend:8081` with Let's Encrypt; `docker-compose.yml` adds `caddy` service `:80/:443`, `frontend` no longer `ports: 8081:8081` on `0.0.0.0` but `expose: 8081`. Fallback: generate self-signed for LAN, set `X-Forwarded-Proto` → FastAPI `root_path`.
2. **HSTS + headers:** `frontend/nginx.conf` add `add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;` when `https`, tighten CSP: keep `style-src unsafe-inline` (Tailwind) but `script-src 'self'` only, remove `unsafe-inline` from `script-src`; add `Permissions-Policy`, keep `X-Frame-Options DENY`, `X-Content-Type-Options nosniff`.
3. **Host validation:** `backend/app/core/config.py:47` change `ALLOWED_HOSTS=*` default to `""` (fail-closed); `backend/app/main.py:303` `trusted_host_check` returns `400` unchanged but `backend/app/services/app_settings_service.py:get_trusted_hosts` must be seeded at boot from `settings.allowed_hosts_list` if DB empty. `frontend/src/pages/AdminPage.tsx:641` Trusted Hosts tab already persists — document `*` means disabled, discourage.
4. **CORS tighten:** `backend/app/main.py: CORS allow_methods ["GET","POST","PUT","DELETE"]` not `"*"`, `allow_headers ["Authorization","Content-Type","X-Request-ID","X-Op-Id"]`.

**Verify:** `curl -k https://host/health` shows `strict-transport`, `curl -H "Host: evil.com"` → `400 Invalid host header`, `docker compose logs caddy` cert OK, `docker compose ps` `caddy healthy`.

### Phase 2 — Credential Hardening (P0, 1-2 days)
1. **JWT lifetime:** `backend/app/core/config.py` `JWT_EXPIRE_DAYS: 0.0208` (≈30 min) + add `JWT_REFRESH_DAYS: 7` and `refresh_token` endpoint `/api/v1/auth/refresh` issuing new `access_token` when `Bearer` within refresh window; `frontend/src/services/auth.ts` `getToken` → dual store `access+refresh`, `frontend/src/services/api.ts:apiRequest` 401→refresh once→retry. Keep `backend/app/services/auth_service.py:decode_access_token` but accept both `sub` windows. Back-compat: existing 30d tokens remain valid until exp.
2. **Revocation (light):** Add `token_blacklist(jti TEXT, exp TIMESTAMPTZ)` in-memory Redis set `blacklist:jti:{jti}` TTL=`exp-now`; `create_access_token` adds `jti=uuid4`; `backend/app/core/security.py:_verify_local_token` checks Redis before `get_user_by_uid`. `logout` + `DELETE /auth/admin/users/{uid}` + password change → blacklist current `jti`s. No full DB needed.
3. **Login lockout:** `backend/app/api/auth.py:143` `login` → `backend/app/services/login_attempt_service.py` (`attempts:{ip→email}` Redis INCR `EXPIRE 15m`, `lock:email:{email}` 15m after 5 fails). Return `429 Retry-After` with same `Invalid email or password` message (avoid user enumeration). Add `rate limit zone=login 5r/m burst 10` `frontend/nginx.conf location /api/v1/auth/login`.
4. **Password policy:** `schemas/AdminCreateUserRequest` `Field(min_length=8)` + `zxcvbn` hint frontend; server check already on `PUT` but add on `POST` (`backend/app/api/auth.py:172`).
5. **Optional TOTP 2FA (opt-in):** Add `users.totp_secret TEXT` + `PUT /auth/me/totp/setup/verify` (`pyotp`), login second step `POST /auth/login {totp?}` if `user.totp_secret IS NOT NULL`. Behind `ENABLE_TOTP=false` env until admin enables. Frontend `LoginPage` second factor field. Keep offline — TOTP is local, no SMS.

**Verify:** `pytest backend/tests/test_auth_api.py` + new `tests/test_login_lockout.py` (5 fails → `429`, success after 15m or delete key), `api/auth.py` 30m token `exp` 1800s, refresh works, `redis-cli KEYS blacklist:*` after logout.

### Phase 3 — Secrets at Rest & Backup (P1, 1 day)
1. **KDF fix:** `backend/app/core/encryption.py` migrate `sha256(SECRET_KEY)` → `HKDF-SHA256(salt=SECRET_KEY[:16], info="api-key")` or `PBKDF2HMAC(salt, 100k)` with version prefix `v2:gAAA...`; new encrypt uses `v2`, decrypt tries `v2` then legacy `v1` then plaintext. Add `alembic 027_encrypt_api_keys.py` that loops `user_ai_settings` + `app_settings admin_provider_keys`, `decrypt→encrypt` if not `gAAA` prefix, logs count. Document rotation = new `SECRET_KEY` + re-run migration (old key needed for decrypt fallback).
2. **Off-site backup key:** `backup/scripts/entrypoint.sh` on first `keys/.backup_key` gen also `cp` to `BACKUP_KEY_OFFSITE_PATH` (env, e.g., mounted `backup_keys` volume or `rclone` remote) and `chmod 600`; `docs/restore` adds `gpg -d | wal-g` off-site fetch step. Add `crontab` nightly `rclone copy system_backups/ remote:scanapp/` if `RCLONE_REMOTE` set (optional, not required for LAN).
3. **Backup `complete:true` alert:** `backup/scripts/full.sh` on `|| log ERROR` also `curl -X POST $BACKUP_ALERT_WEBHOOK` or write `ops_service` `backup_failed` op.

**Verify:** `docker exec scan-app-backend python -c "from app.core.encryption import encrypt_api_key; print(...)"` prefixes `v2`, `select count(*) from user_ai_settings where configs::text like '%gAAA%'`, `ls backup_data/keys` + off-site.

### Phase 4 — Data & Audit (P1, 1-2 days)
1. **KRA field validation:** `backend/app/schemas/receipt.py` `kraPin` regex `^[PA]\d{9,10}[A-Z]$` (warning not fail for OCR — allow but `scan_errors` `kind=validation` + frontend `ReceiptForm.tsx` inline `aria-describedby`), `cuInvoice` `^[0-9\-]{8,30}$` unique partial index `WHERE cu_invoice IS NOT NULL`. Backend `gemini.py` `_normalize_pin` keeps logic but flags `pin_format_invalid`.
2. **Immutable audit:** `audit_logs` add `hash TEXT` chain `hash=sha256(prev_hash||receipt_id||action||changed_by||changes)`, RLS already enabled; doc that PG superuser can still mutate — optional `audit_logs` `WORM` trigger `BEFORE UPDATE/DELETE RAISE`.
3. **Taxonomy audit:** `backend/app/api/locations.py`, `industries.py`, `categories.py`, `entry_types.py` `POST/PUT/DELETE` add `AuditService.log(action=taxonomy_changed)` (extends existing `backend/app/services/audit_service.py:15` fields).

**Verify:** `POST /receipts` with bad `kraPin` → `200` but `scan_errors` + yellow `ReceiptCard`, good PIN passes, `pytest test_reports.py` KRA leading-zero preserved (`@` format).

### Phase 5 — Hardening Leftovers (P1, half day)
- Narrow `docker-compose.yml: user root→appuser` for `frontend` (use `nginxinc/nginx-unprivileged:alpine`), `backend/worker` already `appuser`.
- Add user-based `limit_req zone user:10m rate=20r/s key=$http_authorization` fallback (not just IP) for `extract`.
- SSE: switch `frontend/src/hooks/useMessageStream.ts` from `?token=` to `fetch+ReadableStream` with `Authorization` header (or short-lived 1m `sse_ticket` cookie) to avoid log leak; add `Last-Event-ID` replay from `messages_service` `since` cursor.

## 5. File-Level Change List

| File | Change |
|------|--------|
| `docker-compose.yml` | add `caddy`/`traefik`, change `frontend ports`, `SECRET_KEY:?`, `ALLOWED_HOSTS:?`, `ENABLE_TOTP`, `JWT_EXPIRE_DAYS=0.02`, `BACKUP_KEY_OFFSITE_PATH` |
| `frontend/nginx.conf` | `limit_req login`, `HSTS`, tighten `CSP script-src`, `client_max_body_size` per route, `proxy_hide Server` |
| `frontend/Dockerfile` | base `nginxinc/nginx-unprivileged` |
| `backend/app/core/config.py` | `JWT_EXPIRE_DAYS float default 0.021`, `JWT_REFRESH_DAYS`, `MAX_LOGIN_ATTEMPTS`, `ENABLE_TOTP` |
| `backend/app/services/auth_service.py` | `create_access_token` add `jti`, `decode` return `(uid,jti,exp)`, `blacklist` helpers (Redis) |
| `backend/app/core/security.py` | check `jti` blacklist before `get_user_by_uid`, enforce 401 on blacklisted |
| `backend/app/api/auth.py` | `login` lockout + 429, `refresh` + `logout` blacklist, `POST` password min, TOTP endpoints, document `require_admin` unchanged |
| `backend/app/core/encryption.py` | HKDF v2 prefix, decrypt fallback v1/plain, tests |
| `backend/alembic/versions/027_*` | re-encrypt `user_ai_settings` + `app_settings admin_provider_keys`, add `users.totp_secret`, `audit_logs.hash`, `receipts cu_invoice uniq idx`, `token_blacklist` optional PG |
| `backend/app/services/login_attempt_service.py` (new) | Redis counters |
| `backend/app/services/audit_service.py` | `hash` chain, taxonomy log helper |
| `backend/app/schemas/receipt.py` | `kraPin` regex, `cuInvoice` validators |
| `frontend/src/services/auth.ts`, `frontend/src/stores/authStore.ts`, `frontend/src/services/api.ts` | dual tokens, refresh retry, TOTP UI |
| `frontend/src/pages/LoginPage.tsx`, `frontend/src/hooks/useMessageStream.ts` | lockout banner + TOTP input, SSE header auth |
| `backup/scripts/full.sh`, `backup/scripts/entrypoint.sh`, `ops/restore/README.md` | off-site key copy, alert hook |

## 6. Migrations & Data Safety

- `027` is online, reads plaintext → re-encrypt in place (no delete). `image_bytes` untouched. `audit_logs.hash` nullable backfill forward. `cu_invoice` uniqueness creates partial index — existing nulls unaffected; duplicate non-null values would block migration — pre-check `SELECT cu_invoice, count(*) ... HAVING count>1` and dedup via `cu_invoice || '_' || id` before index.

## 7. Verification & Rollout

- **Per phase green:** `npm run build` (`tsc && vite`), `docker compose build backend frontend`, `docker compose up -d && curl -k https://host/health`, `docker exec scan-app-backend pytest backend/tests/test_auth_api.py backend/tests/test_login_lockout.py backend/tests/test_category_taxonomy.py` (with scratch DB dirs per `AGENTS.md` `IMAGE_STORAGE_DIR=/tmp/...` override).
- **Security drill:** `nmap host:8081` closed, `curl -H "Host: evil"` 400, `hydra` 5+1 login → 429, `jwt decode` exp ~1800s, `redis-cli keys attempts:*`, SSE no `token=` in `nginx access.log`.
- **Rollback:** TLS → `docker compose down caddy && up frontend:8081`; JWT `v2` decrypt falls back to `v1`/plain; auth lockout `redis del attempts:*`.

## 8. Tradeoffs / Alternatives

- **Stay `JWT 30d`** if offline certainty > security — then skip Phase 2 refresh but keep lockout+TOTP; cost is stolen token 30d window.
- **Keep NGINX only + self-signed** if no domain — skip Caddy, just add `ssl_certificate` in `nginx.conf` and `ALLOWED_HOSTS` to LAN IP; still gets HSTS with `preload` off.
- **Full Vault/KMS** over local HKDF — heavier, not needed for single-host.

## 9. Next Step (gated)

Confirm **Phase 1 TLS target** (Caddy vs existing Nginx+certbot, domain/LAN IP for `ALLOWED_HOSTS`), and whether `JWT 30m+refresh` + login lockout is acceptable for UX. If yes, sequence `027` + `backend/app/core/encryption.py` + `backend/app/api/auth.py` lockout first, then perimeter in one compose bump.

---
*Teams checklist: revisit with `docker compose logs backup`, `docker compose exec postgres psql -c "SHOW lc_collate"`, and `./backup/verify.sh` before next release.*
