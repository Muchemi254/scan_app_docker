# Firestore → PostgreSQL Migration Plan

## Context

The scan app currently uses Firestore (NoSQL document DB) for 4 collections:
`receipts`, `audit_logs`, `tasks`, `user_ai_settings`. Batch state already
uses Redis and stays there. Firebase Auth for token validation also stays.

The migration replaces Firestore with PostgreSQL but preserves every API
contract, Pydantic schema, and response shape — the frontend requires no
changes.

---

## 1. PostgreSQL Schema

### 1A. `receipts` table

```sql
CREATE TABLE receipts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         TEXT NOT NULL,                    -- Firebase UID

    -- receipt data
    status          TEXT NOT NULL DEFAULT 'processed', -- 'processed' | 'needs_review'
    supplier        TEXT NOT NULL,
    total_amount    NUMERIC(12,2) NOT NULL DEFAULT 0,
    tax_amount      NUMERIC(12,2),
    receipt_date    DATE NOT NULL,                     -- stored as YYYY-MM-DD
    category        TEXT,
    invoice_number  TEXT,
    kra_pin         TEXT,
    cu_invoice      TEXT,
    batch_title     TEXT,
    image_url       TEXT,
    items           JSONB NOT NULL DEFAULT '[]',       -- [{name, quantity, price, tax, isZeroRated}]

    -- timestamps
    scanned_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ
);

CREATE INDEX idx_receipts_user_id      ON receipts(user_id);
CREATE INDEX idx_receipts_user_status  ON receipts(user_id, status);
CREATE INDEX idx_receipts_user_category ON receipts(user_id, category);
CREATE INDEX idx_receipts_user_batch   ON receipts(user_id, batch_title);
CREATE INDEX idx_receipts_user_date    ON receipts(user_id, receipt_date);
CREATE INDEX idx_receipts_user_supplier ON receipts(user_id, supplier);
CREATE INDEX idx_receipts_user_invoice ON receipts(user_id, invoice_number);
```

**Key decisions:**
- `total_amount` / `tax_amount` become `NUMERIC(12,2)` — the API layer
  must still return `totalAmount` as a string for backward compat. Done
  via the Pydantic model or a serializer.
- `receipt_date` becomes `DATE` — the API layer converts MM/DD/YYYY to
  ISO format on write, and back to MM/DD/YYYY on read.
- `items` stays as `JSONB` — avoids a separate `line_items` table and
  keeps the migration simple. The existing code already treats items as
  a list of dicts.
- `user_id` column replaces the Firestore subcollection path
  `users/{userId}/receipts/`. Every query adds `WHERE user_id = ?`.

### 1B. `audit_logs` table

```sql
CREATE TABLE audit_logs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    receipt_id  UUID NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL,
    action      TEXT NOT NULL,       -- 'created' | 'updated' | 'deleted'
    changed_by  TEXT NOT NULL,       -- Firebase UID
    timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    changes     JSONB NOT NULL DEFAULT '[]'  -- [{field, old_value, new_value}]
);

CREATE INDEX idx_audit_receipt ON audit_logs(receipt_id, timestamp DESC);
CREATE INDEX idx_audit_user    ON audit_logs(user_id);
```

### 1C. `tasks` table

```sql
CREATE TABLE tasks (
    id              UUID PRIMARY KEY,
    user_id         TEXT NOT NULL,
    task_type       TEXT NOT NULL,    -- 'scan_batch'
    batch_title     TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'queued',
    total_items     INT NOT NULL DEFAULT 0,
    completed_items INT NOT NULL DEFAULT 0,
    current_step    INT NOT NULL DEFAULT 0,
    total_steps     INT NOT NULL DEFAULT 0,
    percentage      INT NOT NULL DEFAULT 0,
    message         TEXT NOT NULL DEFAULT '',
    error           TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}',
    results         JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_tasks_user_id    ON tasks(user_id);
CREATE INDEX idx_tasks_status     ON tasks(user_id, status);
CREATE INDEX idx_tasks_created    ON tasks(user_id, created_at DESC);
```

### 1D. `user_ai_settings` table

```sql
CREATE TABLE user_ai_settings (
    user_id   TEXT PRIMARY KEY,
    provider  TEXT NOT NULL DEFAULT 'gemini',
    model_id  TEXT NOT NULL DEFAULT 'gemini-3-flash-preview',
    configs   JSONB NOT NULL DEFAULT '{}'
);
```

---

## 2. Data Type Mappings

| Firestore field | Python/Pydantic type | PostgreSQL column | Write transform | Read transform |
|---|---|---|---|---|
| `id` | `str` | `UUID` | `str(uuid)` ↔ | `str(uuid)` |
| `userId` | `str` | `TEXT` | direct | direct |
| `status` | `ReceiptStatus` enum | `TEXT` | `.value` | direct |
| `supplier` | `str` | `TEXT` | direct | direct |
| `totalAmount` | `str` | `NUMERIC(12,2)` | `sanitize_numeric()` → float | `str(amount)` |
| `taxAmount` | `Optional[str]` | `NUMERIC(12,2)` | `sanitize_numeric()` → float | `str(amount)` or `None` |
| `receiptDate` | `str` ("MM/DD/YYYY") | `DATE` | parse MM/DD/YYYY → date | format → MM/DD/YYYY |
| `category` | `Optional[str]` | `TEXT` | direct | direct |
| `invoiceNumber` | `Optional[str]` | `TEXT` | direct | direct |
| `kraPin` | `Optional[str]` | `TEXT` | direct | direct |
| `cuInvoice` | `Optional[str]` | `TEXT` | direct | direct |
| `batchTitle` | `Optional[str]` | `TEXT` | direct, `None` → `NULL` | direct |
| `imageUrl` | `Optional[str]` | `TEXT` | direct | direct |
| `items` | `List[ReceiptItemCreate]` | `JSONB` | `[i.dict() for i in items]` | `[ReceiptItem(**i) for i in items]` |
| `createdAt` | `datetime` | `TIMESTAMPTZ` | `datetime.utcnow()` | `datetime` |
| `updatedAt` | `Optional[datetime]` | `TIMESTAMPTZ` | `datetime.utcnow()` | `datetime` |
| `scannedAt` | `Optional[datetime]` | `TIMESTAMPTZ` | `datetime.utcnow()` | `datetime` |

**Important:** `totalAmount` and `taxAmount` are `str` in Pydantic schemas but should be stored as `NUMERIC` in PostgreSQL. The database layer converts:
- On **write**: parse the string (removing KES, commas) to a float, store as NUMERIC
- On **read**: convert back to string for the API response

---

## 3. Query Translation — Every Firestore Pattern → SQL

### 3A. `get_receipt(user_id, receipt_id)`

**Firestore:**
```python
get_db().document(f"users/{user_id}/receipts/{receipt_id}").get()
```

**PostgreSQL:**
```sql
SELECT * FROM receipts WHERE id = $1 AND user_id = $2;
```
Returns `Optional[Row]`, raise 404 if None.

### 3B. `list_receipts(user_id, skip, limit, status, category, batch_title)`

**Firestore:**
```python
query = collection.where("status", "==", status)
                  .where("category", "==", category)
                  .where("batchTitle", "==", batch_title)
all_docs = list(query.stream())
total = len(all_docs)
paginated = all_docs[skip:skip+limit]
```

**PostgreSQL:**
```sql
SELECT *, COUNT(*) OVER() AS full_count
FROM receipts
WHERE user_id = $1
  AND ($2::text IS NULL OR status = $2)
  AND ($3::text IS NULL OR category = $3)
  AND ($4::text IS NULL OR batch_title = $4)
ORDER BY created_at DESC
LIMIT $6 OFFSET $5;
```
**Efficiency gain:** No more streaming ALL documents. The DB does real LIMIT/OFFSET.

**Special `__ungrouped__` handling:**
```sql
WHERE user_id = $1
  AND (batch_title IS NULL OR batch_title = '' OR UPPER(batch_title) = 'N/A')
```

### 3C. `search_receipts(user_id, supplier, category, date_from, date_to)`

**Firestore:** where filter + Python-side date string comparison
**PostgreSQL:**
```sql
SELECT *
FROM receipts
WHERE user_id = $1
  AND ($2::text IS NULL OR supplier = $2)
  AND ($3::text IS NULL OR category = $3)
  AND ($4::date IS NULL OR receipt_date >= $4)
  AND ($5::date IS NULL OR receipt_date <= $5)
ORDER BY receipt_date DESC;
```
**Efficiency gain:** Date filtering done natively in the DB (Firestore did string comparison in Python).

### 3D. `check_duplicate(user_id, supplier, totalAmount, receiptDate, invoiceNumber, exclude_id)`

**Firestore:** two separate queries (by invoiceNumber, then by supplier) + Python-side dedup
**PostgreSQL:** single query
```sql
SELECT *
FROM receipts
WHERE user_id = $1
  AND ($2::text IS NULL OR invoice_number = $2)
  AND ($3::text IS NULL OR supplier = $3)
  AND id != COALESCE($4, '00000000-0000-0000-0000-000000000000')
  AND receipt_date = $5
  AND total_amount = $6::numeric;
```

### 3E. `get_receipt_groups(user_id)`

**Firestore:** stream ALL receipts, filter for imageUrl, aggregate in Python
**PostgreSQL:**
```sql
SELECT
    COALESCE(NULLIF(TRIM(batch_title), ''), 'Ungrouped') AS "batchTitle",
    COUNT(*) AS count,
    MIN(image_url) AS "thumbnailUrl",
    COALESCE(SUM(total_amount), 0) AS "totalAmount",
    MAX(receipt_date::text) AS "latestDate",
    MIN(supplier) AS "firstSupplier"
FROM receipts
WHERE user_id = $1
  AND image_url IS NOT NULL
GROUP BY "batchTitle"
ORDER BY count DESC;
```
**Efficiency gain:** No data leaves the database until the aggregated result is ready.

### 3F. `get_audit_trail(user_id, receipt_id)`

**Firestore:**
```python
get_db().collection(f"users/{userId}/receipts/{receiptId}/audit")
        .order_by("timestamp", direction="DESCENDING")
        .stream()
```
**PostgreSQL:**
```sql
SELECT *
FROM audit_logs
WHERE receipt_id = $1 AND user_id = $2
ORDER BY timestamp DESC;
```

### 3G. Task queries

```sql
-- list_tasks(user_id, skip, limit, status)
SELECT *, COUNT(*) OVER() AS full_count
FROM tasks
WHERE user_id = $1
  AND ($2::text IS NULL OR status = $2)
ORDER BY created_at DESC
LIMIT $4 OFFSET $3;

-- get_active_tasks(user_id)
SELECT *
FROM tasks
WHERE user_id = $1
  AND status IN ('queued', 'processing')
ORDER BY created_at DESC;
```

### 3H. User AI Settings

```sql
-- get
SELECT * FROM user_ai_settings WHERE user_id = $1;

-- upsert (replaces set with merge=True)
INSERT INTO user_ai_settings (user_id, provider, model_id, configs)
VALUES ($1, $2, $3, $4)
ON CONFLICT (user_id)
DO UPDATE SET provider = $2, model_id = $3, configs = $4;
```

---

## 4. Files That MUST Change

### 4A. `backend/app/services/firebase_service.py` — Major refactor

**Option A:** Rename to `database_service.py`, replace all Firestore calls with
asyncpg or SQLAlchemy queries. Keep the same method signatures and return
types (`Dict[str, Any]`).

**Option B:** Create `database_service.py` as the new PostgreSQL service,
keep `firebase_service.py` for Firebase Auth only, deprecate the Firestore
methods there.

**Methods affected:**

| Method | Change |
|---|---|
| `init_firebase()` | Remove Firestore init, add PostgreSQL connection pool init |
| `create_receipt()` | `collection.add()` → `INSERT INTO receipts RETURNING id` |
| `get_receipt()` | `document.get()` → `SELECT * FROM receipts WHERE id=$1 AND user_id=$2` |
| `list_receipts()` | `query.where().stream()` → `SELECT ... WHERE ... LIMIT/OFFSET` |
| `update_receipt()` | `document.update()` → `UPDATE receipts SET ... WHERE id=$1 AND user_id=$2` |
| `delete_receipt()` | `document.delete()` → `DELETE FROM receipts WHERE id=$1 AND user_id=$2` |
| `search_receipts()` | `.where().stream()` → `SELECT ... WHERE ... AND receipt_date BETWEEN` |
| `check_duplicate()` | Two-queries + Python dedup → single SQL query |
| `get_receipt_groups()` | Stream all + Python aggregate → `GROUP BY` SQL query |
| `get_user_settings()` | `document.get()` → `SELECT * FROM user_ai_settings WHERE user_id=$1` |
| `update_user_settings()` | `document.set(merge=True)` → `INSERT ... ON CONFLICT DO UPDATE` |

### 4B. `backend/app/services/audit_service.py` — Minor changes

| Method | Change |
|---|---|
| `_create_audit_entry()` | `collection.add()` → `INSERT INTO audit_logs` |
| `get_audit_trail()` | `collection.order_by().stream()` → `SELECT ... ORDER BY timestamp DESC` |

### 4C. `backend/app/services/task_service.py` — Minor changes

| Method | Change |
|---|---|
| `create_task()` | `collection.add()` → `INSERT INTO tasks` |
| `get_task()` | `document.get()` → `SELECT ... WHERE id=$1` |
| `list_tasks()` | `.where().order_by().offset().limit().stream()` → `SELECT ... ORDER BY ... LIMIT/OFFSET` |
| `get_active_tasks()` | `.where(status, in, [...])` → `SELECT ... WHERE status IN (...)` |
| `update_progress()` | `document.update()` → `UPDATE tasks SET ... WHERE id=$1` |
| `add_task_result()` | nested dict update → `UPDATE tasks SET results = results \|\| $1 WHERE id=$2` (JSONB merge) |
| `pause_task()` / `resume_task()` / `delete_task()` | document update/delete → SQL UPDATE/DELETE |

### 4D. `backend/app/services/gemini.py` — No changes needed

Reads AI settings through `FirestoreService.get_user_settings()`. Since the method
signature stays the same (returns `Dict[str, Any]`), no changes needed.

### 4E. `backend/app/main.py` — Startup changes

| Change |
|---|
| `init_firebase()` on startup → Initialize PostgreSQL connection pool |
| Firestore client reference → Replace with asyncpg pool or SQLAlchemy engine |

### 4F. `backend/app/core/config.py` — New settings

```python
DATABASE_URL: str = "postgresql://user:pass@postgres:5432/scanapp"
DATABASE_POOL_MIN: int = 2
DATABASE_POOL_MAX: int = 10
```

### 4G. `backend/requirements.txt` — New dependencies

```
asyncpg>=0.29.0
# OR
sqlalchemy[asyncio]>=2.0
alembic>=1.13
```

### 4H. `docker-compose.yml` — New service

```yaml
postgres:
  image: postgres:16-alpine
  environment:
    POSTGRES_DB: scanapp
    POSTGRES_USER: scanapp
    POSTGRES_PASSWORD: ${DB_PASSWORD}
  volumes:
    - pgdata:/var/lib/postgresql/data
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -U scanapp"]
    interval: 5s
    timeout: 5s
    retries: 5

volumes:
  pgdata:
```

### 4I. `backend/app/services/batch_service.py` — No changes needed

Already uses Redis. Firestore-independent.

### 4J. `backend/app/services/data_cleaning_service.py` — Query changes

Currently calls `FirestoreService.list_receipts()` and
`FirestoreService.get_receipt()` / `update_receipt()`. Since those methods keep
the same signatures, this file changes only if we optimize the underlying
queries (e.g., pushing the aggregation to SQL).

---

## 5. Files That DO NOT Change

| File | Reason |
|---|---|
| `backend/app/api/receipts.py` | Service methods keep same signatures |
| `backend/app/api/tasks.py` | Same |
| `backend/app/api/settings.py` | Same |
| `backend/app/api/batches.py` | Uses Redis, not Firestore |
| `backend/app/api/cleaning.py` | Through data_cleaning_service |
| `backend/app/api/exports.py` | Through FirestoreService.list_receipts |
| `backend/app/api/images.py` | No DB access |
| `backend/app/api/health.py` | No DB access |
| `backend/app/core/security.py` | Firebase Auth only, stays |
| `backend/app/schemas/*.py` | Zero changes — these are the contract |
| `backend/app/services/image_service.py` | No DB access |
| `backend/app/services/model_registry.py` | Static data |
| `backend/app/tasks/worker.py` | Calls TaskService (signatures unchanged) |
| `backend/app/core/celery_app.py` | Redis-backed, unchanged |
| `frontend/**` | API contract preserved |

---

## 6. Data Migration Strategy

### Phase 1: Schema migration (alembic)
1. Run `alembic upgrade head` to create all PostgreSQL tables.
2. PostgreSQL runs alongside Firestore — new writes go to both during a
   transition window (or go directly to PostgreSQL if doing a hard cutover).

### Phase 2: Data export from Firestore
```bash
# Export Firestore data via gcloud
gcloud firestore export gs://bucket/export-YYYYMMDD \
    --collection-ids=receipts,tasks,settings
```

Or write a one-shot migration script that:
1. Streams all documents from each Firestore collection
2. Applies the type transforms (string amounts → NUMERIC, MM/DD/YYYY → DATE)
3. Inserts into PostgreSQL via `COPY` or batched INSERT

### Phase 3: Validation
- Compare record counts per user
- Sample-compare receipt fields between Firestore and PostgreSQL
- Run the API test suite against the PostgreSQL backend

### Phase 4: Cutover
- Switch the service layer from FirestoreService to DatabaseService
- Remove Firestore dependencies from `requirements.txt`
- Remove Firebase Admin SDK project initialization for Firestore

---

## 7. Risk Items

| Risk | Mitigation |
|---|---|
| Data loss during migration | Write to both systems during transition or verify exports |
| `receiptDate` format inconsistency | Normalize all dates during migration; validate with regex |
| `totalAmount` parsing failures | Handle KES prefix, commas, empty strings during migration |
| Missing `items` data | Default to `[]` (JSONB empty array) for null/missing items |
| Performance regression on group queries | PostgreSQL `GROUP BY` is faster than Firestore stream + Python |
| Connection pool exhaustion | Set appropriate pool sizes; use asyncpg's built-in pooling |
| Firebase Auth stays dependent on Firestore? | No — auth token validation is independent |
| Enabling `items[*].price` queries in SQL | Stays as JSONB; can add GIN index later if needed |

---

## 8. Optional Optimizations (Post-Migration)

These are NOT required but become possible after migration:

1. **Normalized `line_items` table** — Move `items` from JSONB to a proper
   relational table for queryable prices/taxes
2. **Database-level summary computations** — Push spending summary, category
   breakdowns to SQL aggregates
3. **Full-text search on supplier names** — PostgreSQL `tsvector` / `pg_trgm`
   instead of client-side filter loops
4. **Keyset pagination** — Replace `LIMIT/OFFSET` with cursor-based pagination
5. **Materialized views** — Pre-compute monthly spending trends, category
   breakdowns
6. **Row-level security** — Enforce multi-tenancy at the database level with
   `user_id = current_setting('app.current_user_id')`

---

## 9. Implementation Order

1. Add PostgreSQL to `docker-compose.yml`
2. Add `asyncpg` or `SQLAlchemy[asyncio]` to `requirements.txt`
3. Create `backend/app/core/database.py` — connection pool setup
4. Create Alembic migration for all 4 tables
5. Create `backend/app/services/database_service.py` — Receipt CRUD
6. Replace calls in `firebase_service.py` → delegate to `database_service.py`
7. Update `audit_service.py` for PostgreSQL
8. Update `task_service.py` for PostgreSQL
9. Update `main.py` startup to init PostgreSQL pool
10. Write Firestore → PostgreSQL data migration script
11. Remove Firestore dependencies
