# Critical Issues & Security Concerns

## Resolved Issues (Migration)

| ID | Issue | Impact | Fix |
|----|-------|--------|-----|
| M1 | Items not displaying in view/edit forms | User couldn't see/edit line items | `useState` replaced with `useEffect` sync in ReceiptForm; `list_receipts` now batch-loads items |
| M2 | Images 404 — HEIC files stored raw, Docker volume mismatch | 222 receipts had broken images | HEIC→JPEG conversion on-the-fly in image proxy; `docker cp` images to volume |
| M3 | JSONB columns returned as strings | Settings/Audit API returned 500 | `json.loads()` fallback on read, `json.dumps()` on write |
| M4 | 4× item row duplication from re-migration | 5,860 rows instead of 1,465 | `ON CONFLICT (receipt_id, sort_order)` + dedup script |
| M5 | Update blanking optional fields with `''` | batchTitle, kraPin, cuInvoice cleared on edit | Dynamic SET skips empty strings for optional fields |
| M6 | Delete returns 500 — datetime not JSON serializable | Could not delete receipts | `json.dumps(default=str)` in audit log |
| M7 | Audit log shows null/empty/N/A entries | Misleading audit trail display | Filter meaningless values in `log_create` and `log_delete` |
| M8 | Batch scan retry button never appears | Failed scans couldn't be retried | Backend polling implemented in `useTaskProgress` (3s interval) |
| M9 | Scans auto-marked as `processed` | Receipts skipped manual review | All scans now always `needs_review` |
| M10 | Text PKs vs UUID — Firestore IDs incompatible | Migration failed on ID insert | Changed all PKs from UUID to TEXT |
| M11 | `::uuid` casts left in SQL after TEXT PK change | Query errors | Removed all `::uuid` casts |

---

## Security Concerns — Infrastructure

### Secrets & Credentials

| # | Concern | Severity | Current State | Recommendation |
|---|---------|----------|---------------|----------------|
| S1 | **SECRET_KEY defaults to `"change-me-in-production"`** | 🔴 Critical | `config.py:70` — no startup enforcement | Require env var, crash on default. Rotate existing keys. |
| S2 | **API keys stored plaintext in PostgreSQL** | 🔴 Critical | `user_ai_settings.configs` contains Gemini + DeepSeek API keys as plaintext JSON | Encrypt at rest via `encryption.py:encrypt_api_key()`. Keys are only encrypted on next write — run a one-shot migration to encrypt all existing keys. |
| S3 | **DB password in docker-compose.yml** | 🟡 Medium | `DB_PASSWORD` env var with default `scanapp_dev` exposed in compose file | Use Docker secrets or `.env` file (gitignored). Never commit default password. |
| S4 | **Firebase service account JSON mounted readable** | 🔴 Critical | `docker-compose.yml:25` — `firebaseservice.json:ro` mounted into container | The service account has full project access. Restrict IAM role. Consider workload identity federation. Ensure `.gitignore` blocks this file (it does now). |
| S5 | **Backup files contain plaintext API keys** | 🔴 Critical | `backup_service.py:export_user_data()` — exports `user_ai_settings` including `configs` with plaintext API keys | Encrypt keys in the backup, or strip `configs` from backup export. |
| S6 | **Redis has no authentication** | 🟡 Medium | `REDIS_URL: redis://redis:6379/0` — no password | Add `requirepass` to Redis config. Use `rediss://` if TLS needed. |
| S7 | **Celery worker uses same Firebase credentials** | 🟡 Medium | Worker mounts same `firebaseservice.json` with full access | Same as S4 — restrict IAM. Worker only needs Storage access, not Firestore. |

### Network & Transport

| # | Concern | Severity | Current State | Recommendation |
|---|---------|----------|---------------|----------------|
| N1 | **No HTTPS/TLS** | 🔴 Critical | Nginx listens on port 80 only, no SSL termination | Add TLS via Let's Encrypt or reverse proxy. Tailscale provides encryption but LAN traffic is plaintext. |
| N2 | **Nginx accepts any hostname** | 🟡 Medium | `server_name _;` in frontend nginx.conf — no host validation | Restrict to known hostnames to prevent DNS rebinding attacks. |
| N3 | **Nginx hides backend Server header** | ✅ Good | `proxy_hide_header Server;` configured | Already done. |
| N4 | **SSRF protection in image proxy** | 🟡 Medium | `images.py` validates URLs against private IP ranges | Good. Add hostname allowlist (only firebasestorage.googleapis.com + local). |
| N5 | **Rate limiting bypassable** | 🟡 Low | Rate limits per IP — can be bypassed with multiple IPs | Add token-based rate limiting for authenticated users. |
| N6 | **Docker containers on same bridge network** | 🟡 Medium | All services share `app-network` — compromised container can reach all others | Use separate networks per tier (frontend→backend, backend→db, backend→redis). |

### Container Security

| # | Concern | Severity | Current State | Recommendation |
|---|---------|----------|---------------|----------------|
| C1 | **Containers run as root** | 🟡 Medium | Backend Dockerfile has no `USER` directive. Frontend Nginx runs as root. | Add `USER 1000` in Dockerfiles. Nginx can use `nginx` user. |
| C2 | **No read-only filesystem** | 🟡 Low | Container filesystems are writable | Mount code as read-only, only `/app/data/images` needs write access. |
| C3 | **No resource limits** | 🟡 Low | No `mem_limit` or `cpu_shares` in docker-compose | Add limits to prevent DoS via resource exhaustion. |
| C4 | **Pillow/imaging library surface** | 🟡 Low | HEIC→JPEG conversion processes untrusted input | Keep pillow-heif updated. Add file size limits before processing. |

---

## Security Concerns — Multi-Tenant Data Isolation

| # | Concern | Severity | Current State | Recommendation |
|---|---------|----------|---------------|----------------|
| T1 | **No row-level security** | 🔴 Critical | Multi-tenancy enforced only via `WHERE user_id = $1` in every query. A missing WHERE clause exposes all users' data. | Enable PostgreSQL Row-Level Security: `CREATE POLICY user_isolation ON receipts USING (user_id = current_setting('app.current_user_id'))`. |
| T2 | **URL path user validation is manual** | 🟡 Medium | Each endpoint calls `verify_user_access(userId, current_user_id)` — human error possible | Move to middleware/dependency that validates `userId == token.uid` before route handler executes. |
| T3 | **No audit trail for cross-tenant access attempts** | 🟡 Low | 403 returned but not logged as security event | Log all 403 responses with user/endpoint/IP for intrusion detection. |
| T4 | **Image files not namespaced by user** | 🟡 Low | Images stored as `{receipt_id}.jpg` — receipt_id is global but tied to user via DB | Add user directory: `{user_id}/{receipt_id}.jpg` for defense in depth. |

---

## Security Concerns — Application Layer

| # | Concern | Severity | Current State | Recommendation |
|---|---------|----------|---------------|----------------|
| A1 | **XSS via supplier/item names** | 🟡 Medium | Supplier names from receipts injected into HTML without sanitization | React's JSX auto-escapes most content. Verify `<img>` alt text and `title` attributes don't bypass. Add CSP header. |
| A2 | **No Content Security Policy** | 🟡 Medium | No CSP header set by Nginx or backend | Add `Content-Security-Policy` header restricting scripts/styles to self. |
| A3 | **File upload validation by content-type** | 🟡 Low | `batches.py:218` checks `content_type` but trusts client header | Validate by magic bytes, not Content-Type header. |
| A4 | **No request ID / correlation tracking** | 🟡 Low | Logs don't include request IDs | Add middleware to generate and attach `X-Request-ID` for debugging. |
| A5 | **Firebase token expiry not refreshed** | 🟡 Medium | Frontend `firebase.tsx` uses `onAuthStateChanged` — no explicit refresh | Verify Firebase SDK auto-refreshes. Add 401 interceptor for token refresh. |
| A6 | **Debug endpoints enabled in production** | 🟡 Low | `/docs` (Swagger UI) always exposed | Conditionally enable based on `ENABLE_DOCS` env var (already exists, default True). Set to False in production. |

---

## Data Integrity

| # | Concern | Severity | Current State | Recommendation |
|---|---------|----------|---------------|----------------|
| D1 | **No database backups configured** | 🔴 Critical | No automated pg_dump or backup schedule | Implement cron/pg_dump + upload to external storage. Use the existing backup system as periodic export. |
| D2 | **No migration rollback tested** | 🟡 Medium | Alembic downgrade not verified | Test `alembic downgrade` on staging before production deployments. |
| D3 | **Image orphans on failed saves** | ✅ Fixed | `batches.py` now cleans up images on exception | Already fixed in M2/M9. |
| D4 | **No data validation on import** | 🟡 Medium | `export_user_data` includes all fields, `import_user_data` trusts the data | Validate imported data against Pydantic schemas before INSERT. |

---

## Priority Action Items (Ordered)

1. **🔴 Encrypt API keys at rest** — Run one-shot script to encrypt all `user_ai_settings.configs` values using `encryption.py`
2. **🔴 Enable RLS on PostgreSQL** — Row-level security for multi-tenant isolation
3. **🔴 Add HTTPS** — TLS termination via Let's Encrypt or Cloudflare Tunnel
4. **🔴 Secure SECRET_KEY** — Crash on default, rotate
5. **🔴 Strip API keys from backups** — Or encrypt the backup file
6. **🟡 Restrict Firebase IAM** — Create minimal-permission service account
7. ✅ **Add Redis auth** — `--requirepass` in redis.conf, password in REDIS_URL
8. 🟡 Container non-root — Add USER directives to Dockerfiles
9. 🟡 Add Content-Security-Policy header
10. 🟡 Database backups — Automated pg_dump schedule
11. 🟡 Network segmentation — Separate Docker networks per tier
12. 🟡 Disable Swagger in production — `ENABLE_DOCS=false`

---

## Redis — Data Isolation & Live Scans

### Architecture

Redis stores two kinds of data:

| Key Pattern | Data | User-Isolated | TTL |
|---|---|---|---|
| `batch:{userId}:{batchId}` | Batch scan state (progress, per-file status, receipt IDs) | ✅ Namespaced by userId | 24h |
| `user_batches:{userId}` | Set of active batch IDs for a user | ✅ Per-user set | None |
| `heic:img:{url}` | Image proxy cache (JPEG bytes) | ❌ Shared across users | 24h |
| In-memory `_batch_images` dict | Raw image bytes during batch processing | ❌ No isolation, lost on restart | Process lifetime |

### Security Measures Applied

1. **Redis password authentication** — `redis-server --requirepass` prevents unauthorized access
2. **Batch keys namespaced by user** — `batch:{userId}:{batchId}` prevents cross-user batch access via Redis directly
3. **API-level access control** — `_require_owner(batch, userId)` checks `batch.userId` before returning data
4. **Image cache** — Keys are URL-based. Local receipt image URLs are unguessable UUIDs/strings. For production, add signed URL tokens.

### Remaining Risks

| Risk | Mitigation |
|---|---|
| Image proxy no auth (can't send headers via `<img>` tags) | Receipt IDs are opaque — brute-force impractical. Add short-lived tokens for production. |
| In-memory image store not isolated | Cleared after batch completion. Lost on restart (batch auto-failed). |
| Redis single-instance, no failover | Add Redis Sentinel or use managed Redis for production. |
