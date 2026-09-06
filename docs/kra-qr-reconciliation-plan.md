# KRA & Receipt Reconciliation Master Plan — Saved 2026-09-06

> Consolidated revisit plan covering: Yearly breakdown independence, KRA CU/PIN verification via `itax.kra.go.ke` / `ecitizen`, prefix anomaly cleaning, QR fallback, standalone scraper service, flagged-not-blocked recheck, and anti-bot shaping. Build-mode: doc only this step; implementation remains phased per sections.

---

## 1. Yearly Breakdown — Dashboard Independence (Implemented 2026-09-06)

**Requirement:** Yearly Breakdown must be independent of the Year dropdown (attempts to list years), showing last 5 years but controlled by other filters except year.

**Implemented:**

- **Backend `backend/app/services/dashboard_service.py:68`** `get_yearly(user_id, industry_id, include_unreviewed, last_n=5)` — calls `_fetch_receipts(..., None, None, industry_id, include_unreviewed)` (no `date_from/date_to`), aggregates `YYYY` from `receiptDate` via `_parse_date_mmddyyyy`, returns last 5 calendar years (`now().year -4 .. now().year`) with fallback to most recent N years that have data, each `{year,label,total,count,avg_per_receipt}`.
- **API `backend/app/api/dashboard.py:36`** `GET /{userId}/dashboard/yearly?industry_id&include_unreviewed&last_n` → `DashboardYearly` (`backend/app/schemas/dashboard.py:1` `YearPoint`).
- **Frontend `frontend/src/services/api.ts:916`** `dashboardApi.yearly(industry_id, include_unreviewed)`; `frontend/src/pages/DashboardPage.tsx:97` state `yearly` + `loading.yearly`, split fetch: `fetchAll` (overview/trends/breakdown/insights with `dateFilters`) and `fetchYearly` (industry+verified only) via separate `useEffect`; `yearlyComparison` now derived from `yearly.yearly`; card subtitle `Last 5 years`, loading `loading.yearly`.

**Verify:** `curl http://localhost:8003/openapi.json | python -c "print([k for k in d['paths'] if 'dashboard' in k])"` includes `/dashboard/yearly`, compose `backend+frontend` healthy.

---

## 2. KRA CU/PIN Verification — Portal Reality

- **CU:** `https://itax.kra.go.ke/KRA-Portal/invoiceChk.htm?actionCode=loadPage&invoiceNo=0041176350000014228` — single GET returns HTML with invoice status; no official API. Lightweight `httpx GET ?invoiceNo=` with allowlist `itax.kra.go.ke` works today but HTML selector fragile, may add captcha/IP block at any time.
- **PIN:** `kra.go.ke` checker has human `+ / -` captcha; alt `https://ecitizen.kra.go.ke/checkers/Checkers-Pin` requires textbox + Verify (also captcha/hCaptcha). Cannot reliably automate with `httpx` alone.
- **Current store:** `receipts.kra_pin|buyer_kra_pin|cu_invoice TEXT NULL` (`alembic/001_initial_schema.py:32`), `schemas/receipt.py:61` freeform, `gemini.py:444` extraction prompt `P05115959U` / `004084202207080184`, FTS `018_search_indexes.py:19` includes cu fields, no `CHECK`/`UNIQUE` (proposed `^[PA]\d{9,10}[A-Z]$` in `security-hardening-plan.md:7`).
- **No scraping code today:** `grep qrcode|pyzbar|playwright` 0 hits, `httpx==0.25.2` only external client, `tasks/worker.py` `pool=threads concurrency=2`.

---

## 3. Target: Background Reconciliation on `processed` (Not Pipeline Gate)

**Rationale for 1000-receipt scale:** Upload `1600px` → `prepared (hash dedupe)` → `dispatch Celery 10/3 PDF chunks` → `needs_review → pending_approval → processed` (`batch_service.py:585`, `tasks/worker.py:997`, `receipt_workflow_service.py:2`) is already durable and billed. Gating save on KRA would multiply latency, hit IP ban, block `needs_review`. Derive KRA as **cacheable background check** (like `022` `image_bytes` mirror `self_heal_image_files()` `main.py:119`).

**Cache columns (when implemented):**
```sql
ALTER TABLE receipts ADD COLUMN kra_cu_status TEXT; -- NULL|valid|not_found|mismatch|error|needs_captcha
ALTER TABLE receipts ADD COLUMN kra_checked_at TIMESTAMPTZ;
ALTER TABLE receipts ADD COLUMN kra_verified BOOL;
ALTER TABLE receipts ADD COLUMN kra_tax_match TEXT; -- exact|close|mismatch
ALTER TABLE receipts ADD COLUMN kra_response_hash TEXT;
CREATE INDEX idx_receipts_kra_checked_at ON receipts(kra_checked_at) WHERE kra_cu_status IS NOT NULL;
CREATE TABLE kra_verifications(id UUID, user_id TEXT, receipt_id TEXT FK, cu_invoice TEXT, status TEXT, kra_total NUMERIC, kra_tax NUMERIC, tax_match TEXT, checked_at TIMESTAMPTZ, html_snippet_hash TEXT);
CREATE TABLE kra_jobs(id UUID, user_id TEXT, receipt_id TEXT, cu_invoice TEXT, status TEXT, attempt_no INT, captcha_image TEXT, result JSONB);
```

**Reconcile “close enough” tax:**
```python
def reconcile(ours_total, ours_tax, kra_total, kra_tax, tol_abs=1.0, tol_pct=0.01):
    total_ok = abs(ours_total - kra_total) <= max(tol_abs, kra_total * tol_pct)
    tax_ok   = abs(ours_tax - kra_tax) <= max(tol_abs, kra_tax * tol_pct) if kra_tax else (ours_tax==0)
    if total_ok and tax_ok: return "exact"
    if total_ok and not tax_ok and abs(ours_tax - kra_tax)/(kra_tax or 1) < 0.05: return "close"
    return "mismatch"
```

---

## 4. Flag-Not-Block + Recheck (User Requirement 2026-09-06)

**User asks:** No block on export, but need flag that it failed, then recheck; review issues, second retry.

**States:**

| `kra_cu_status` | `kra_verified` | `kra_tax_match` | Badge | In flagged queue? |
|---|---|---|---|---|
| NULL | NULL | NULL | — grey | No (unchecked) |
| valid | true | exact | ✓ Verified emerald | No |
| valid | true | close | ⚠ Close amber | Optional |
| valid | false | mismatch | ✗ Mismatch red | **Yes** |
| not_found | false | NULL | ✗ Not found red | **Yes** |
| error | false | NULL | ! Error slate | **Yes** |
| needs_captcha | false | NULL | ? Captcha yellow | **Yes** |

**Flagged = `kra_verified=false OR tax_match=mismatch OR status∈(not_found,error,needs_captcha)`.**

**UI flags (never gate):** `ReceiptsTableView.tsx:27` cols `KRA CU`, `Tax Match`, `Last Checked`; `ReviewPanel.tsx:62` badges + KRA link `invoiceChk.htm?invoiceNo=`; `DataCleaningPage.tsx:13` suggestion `kra_flagged` + counts; bulk `Recheck` buttons.

**Recheck lifecycle (second retry):**
- `POST /users/{id}/kra/recheck {receiptId}` idempotent; `POST /users/{id}/kra/recheck {filter: flagged, ids?, limit:50}` chord 50; optional `KRA_NIGHTLY=false` beat 03:00 limit 200; post-approve auto-enqueue single.
- Worker `kra` `concurrency=1 rate_limit 5/m Semaphore(1) httpx timeout 20 follow_redirects=False allowlist itax.kra.go.ke getaddrinfo+BLOCKED_CIDRS`, jitter `0.8-1.2` (`error_codes.py:107`), respect `Retry-After`.
- Transient `error` → retry after 15m jitter; `not_found/mismatch` → no auto-retry; `needs_captcha` → stays flagged until manual `POST /jobs/{id}/captcha`.
- Dedup by `cu_invoice` reuse one fetch; skip if `kra_checked_at > now-24h` unless `force=true` or `updatedAt > kra_checked_at`.

---

## 5. Anti-Bot Shaping for KRA Bulk

**Why bulk 1000 maps to bot:** Single host burst 1000×5/m without `Referer/Accept-Language/Cookie` → `429 + __cf_bm + hCaptcha`. Inbound `nginx.conf:8` `api 10r/s` not outbound throttle.

**Shaping (reuse `celery_app.py:22` `acks_late=True`):** Governor `limit 20` per recheck call, dedup `cu_invoice`, `12s+jitter` between hits, stagger 1000 → `20×50` over ~3h. Single egress IP via throttling suffices; NAT sidecar `kra-proxy` (`tinyproxy` + `KRA_PROXY_URL`) only if `429/total>0.2`.

**Request fidelity:** `User-Agent Mozilla/5.0 Chrome/120`, `Accept text/html`, `Referer https://itax.kra.go.ke/KRA-Portal/`, `Accept-Language en-KE`, per-`kra_jobs` `CookieJar` encrypted `Fernet(hashlib.sha256(SECRET_KEY))` `gAAA` prefix (`core/encryption.py:21`), DNS `127.0.0.11 valid=10s`.

**Captcha stance:** Never auto-solve with 2Captcha (violates ToS, DPA 2019 §37, Computer Misuse §18). Mark `needs_captcha`, push SSE `messages/stream` `nginx.conf:71`, frontend `MessageCenter.tsx:352` captcha card.

---

## 6. Standalone Scraping Service — Independent of Others

**User wants:** scraper as independent service, not library inside backend.

**Spec:**
```yaml
kra-scraper:
  build: ./kra-scraper   # python:3.11-slim + playwright chromium only here (not backend/worker)
  networks: [data-network]
  depends_on: [postgres, redis]
  environment: {DATABASE_URL, REDIS_URL, ALLOWED_KRA_HOSTS: "itax.kra.go.ke", KRA_PROXY_URL, SECRET_KEY}
  deploy: {resources: {limits: {memory:512m}}}
  restart: unless-stopped
  volumes: [kra_scratch:/tmp/kra]
```

- `Celery("kra", broker=REDIS_URL/2, backend=REDIS_URL/3, include=["kra.tasks"])` `rate_limit 5/m soft 60`. `kra/tasks.py` `kra_scrape(jobId)` `asyncio.run(_scrape)` `Semaphore(1)`. `kra/parser.py` `selectolax` parse `Total/Tax`.
- Contract: backend enqueues `kra_jobs` + `send_task("kra.scrape", queue="kra")`; scraper writes `kra_verifications` + `receipts.kra_*` via `set_config('app.current_user_id', job.user_id)`.
- Isolation: image `playwright 150MB` only in scraper, no `backend/worker` bloat; network no host ports; crash → Postgres `pending` re-queued `reap 30m` (like `main.py:182` `_reap_loop`).

**Alternative keep monorepo `./kra-scraper/` vs fresh repo:** Recommended monorepo sidecar single `docker compose up`.

---

## 7. CU Prefix Anomaly Cleaning (Verified 2026-09-06)

**User noted:** For a given company CU’s leading digits stable, tail varies, outlier prefix flags erroneous numbers → add to cleaning, reduce errors before KRA.

**Verification on live 2784 receipts (1326 with cu):**
- `IMARA P000635329W 64 cu`: `d_p10=6` (`0110680530` majority 64, minority `011868...`), not perfectly stable.
- `PATRICA P052243329U 28 numeric`: `p13=0041176350000` majority 20/28 (0.71), outliers `0041176750000019` (`675≠635`), `08411763...` (`0→8`), `88411763...` — tail `002120` vs `010513` differs in last 4-6 digits, length 15-20.
- `MAAR 37 cu d_p10=7`, `LAXCON 40 cu d_p10=14` chaotic (`2EA8CC...` hash-like) — not stable. `KRAMW*`, `654`, `N/A` noise (<10 len, letters) excluded.

**Verdict:** True for **numeric 15-20 digit ETIMS** suppliers, not for legacy/hash sets. Must scope `supplier+kra_pin`, `len≥15`, `^[0-9]{15,30}$`, `n≥5`, majority `p13` `freq≥0.6`.

**Algorithm `suggest_cu_prefix_anomalies`:**
1. Group by `normalize_supplier.lower(), kra_pin` (`data_cleaning_service.py:31`).
2. Filter numeric long `n≥5`.
3. Mode `p13 = cu[:13]`.
4. Flag where `left13 != mode` OR len outlier.
5. `kind='cu_prefix_anomaly'` → `DataCleaningPage` tab `CU Prefix` `Expected 0041176350000 saw 0041176750000`.

**Files:** `data_cleaning_service.py` add `suggest_cu_prefix_anomalies`, `api/cleaning.py` return `cu_prefix_anomalies`, `DataCleaningPage.tsx` tab, `tests/test_cleaning_suggestions.py`.

---

## 8. QR Code Fallback — Without Camera / Without Heavy AI / Without 3rd Party

**Current pipeline:** `_detect_image_format` magic bytes, `process_image() 1600px JPEG 82`, `prepare_for_ai() 1024px`, `pdf render 150dpi` (`image_service.py:231`), `save_image` rebuild-proof `022`, `tasks/worker.py 10/3 PDF chunks`. No QR code (`grep qrcode|pyzbar 0 hits`, `requirements.txt` no `opencv`).

**Automated where-is-QR without camera:** Whole-image detector finds finder patterns (3 squares) — `pyzbar` (`libzbar`) or `opencv QRCodeDetector` returns `[(x,y,w,h), data]` in 30-80ms on `800px` downscale, no ROI prior needed. Humans pointing = manual ROI; automation = detector’s output is ROI.

**Stack (no AI, no external):** `pip pyzbar opencv-python-headless` + `apt libzbar0` in `kra-scraper` or `backend` `Dockerfile` `poppler-utils` line; `Pillow` grayscale → `adaptiveThreshold` → `pyzbar.decode(img, symbols=[QRCODE])` → fallback `QRCodeDetector.detectAndDecodeMulti` for rotation; crop 5% padding re-decode at `1600px` for ECC `L/M/Q/H` up to 30% damage.

**Hook (post-processed, not pre-save):** After `extract_receipt_batch`, enqueue `qr_verify` on `image_bytes` JPEG (same 1000-scale concern) → `receipts.qr_payload`, `qr_bbox`, `qr_checked_at` cache + `qr_verifications` audit; `ImageViewer.tsx:292` overlay polygon; `data_cleaning_service` `cu_qr_mismatch` suggestion copies `qr_payload` to `cuInvoice` if OCR drifts (e.g., `004117675` vs QR `004117635`).

**HEIC/PDF:** `pillow_heif` already registered, `render_pdf_pages` path used for `openrouter/qwen` already yields JPEG for QR.

**Resource:** `30ms/image`, `5-15MB` RAM, `~90MB` wheel; avoids SaaS leak of PII (`supplier PIN`) and token cost.

---

## 9. File Checklist (When Approved)

| Domain | Path | Action |
|---|---|---|
| Dashboard | `api/dashboard.py`, `services/dashboard_service.py`, `schemas/dashboard.py`, `services/api.ts`, `pages/DashboardPage.tsx` | Done (yearly) |
| KRA cache | `alembic/028_kra_flag_recheck.py` | cache cols + `kra_jobs|kra_verifications` + flagged index |
| KRA API | `api/kra.py` | `POST /kra/recheck`, `GET /kra/verifications|flagged`, `POST /jobs/{id}/captcha` |
| KRA service | `services/kra_service.py` | `validate_cu + reconcile` + allowlist SSRF |
| Cleaning | `services/data_cleaning_service.py`, `api/cleaning.py`, `pages/DataCleaningPage.tsx` | `cu_prefix_anomaly` + `kra_flagged` |
| QR | `services/qr_service.py` (or `kra-scraper/kra/parser.py`) | `try_qr_decode` |
| Scraper | `kra-scraper/Dockerfile, requirements.txt, kra/tasks.py` | standalone Celery `kra 5/m` |
| Compose | `docker-compose.yml` | `kra-scraper` `kra_scratch` |
| Frontend | `services/api.ts:916`, `ReceiptsTableView.tsx:27`, `ReviewPanel.tsx:62` | badges `KRA CU/Tax`, `QR` |

---

## 10. Open Decisions (record answers here before execution)

1. **Yearly:** `Last 5 calendar years` implementation kept; adjust `last_n` via `?last_n=10` if needed.
2. **KRA trigger:** Auto on `approve` + bulk `flagged` + optional nightly? Default bulk manual.
3. **Tolerance:** `1 KES/1% exact, 5% close` — confirm close counts as verified?
4. **Missing CU:** `cu_invoice NULL` → `NULL` skip or `no_cu` flagged?
5. **Captcha:** CU-only v1 (no captcha today per `invoiceChk.htm` link) or include `ecitizen` PIN bridge day-1?
6. **QR scope:** Every `processed` image or only `flagged cu_prefix_anomaly/kra_not_found` subset?
7. **Scraper repo:** Monorepo `./kra-scraper/` (recommended single compose) or fresh repo?

---
*Next: answer open decisions, then lift build-mode to implement 028 + kra-scraper sidecar.*
