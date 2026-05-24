# Search Implementation

## Overview

Full-text search across all receipt attributes — supplier, category, invoice number,
KRA PIN (seller + buyer), CU invoice, batch title, date, amount, and item names.
Results are ranked by PostgreSQL's `ts_rank` and returned with relevance scores.

## Files Involved

### Backend

| File | Purpose |
|------|---------|
| `backend/app/services/database_service.py` (line ~634) | `search_receipts_fulltext()` — PostgreSQL full-text query with GIN index + ILIKE fallback |
| `backend/app/api/receipts.py` (line ~331) | `GET /receipts/search?q=...` — FastAPI endpoint wrapping the search service |
| PostgreSQL index | GIN index on `to_tsvector('simple', supplier || category || ...)` created at migration time |

### Frontend

| File | Purpose |
|------|---------|
| `frontend/src/services/api.ts` (line ~238) | `receiptApi.search(q, limit, offset)` — calls `GET /receipts/search` via `apiRequest()` |
| `frontend/src/pages/ViewScansPage.tsx` (line ~36-50) | Search state + debounced handler. Input in sidebar above sort controls |
| `frontend/src/pages/ViewScansPage.tsx` (line ~96-100) | `filteredReceipts` useMemo — routes to search results when active |

## How It Works

### 1. The Query (PostgreSQL)

```
User types "hardware" in the search box
  ↓ (300ms debounce)
GET /api/v1/users/{uid}/receipts/search?q=hardware&limit=25&offset=0
  ↓
database_service.py::search_receipts_fulltext()
```

The SQL uses two strategies combined with `OR`:

**A. Full-text search (GIN index — fast for keyword matching):**
```sql
to_tsvector('simple', COALESCE(supplier,'') || ' ' || COALESCE(category,'') || ...)
  @@ websearch_to_tsquery('simple', 'hardware')
```
- `to_tsvector('simple', ...)` concatenates all text fields into a searchable document
- `websearch_to_tsquery('simple', 'hardware')` converts the query into a boolean search
- `ts_rank(...)` scores each result by relevance

**B. ILIKE fallback (catches partial matches GIN misses):**
```sql
supplier ILIKE '%hardware%' OR category ILIKE '%hardware%' OR ...
```
- Substring matching on every text field + item names
- Also matches `receipt_date::text` and `total_amount::text` for date/amount searches

Both run in a single query. Results are distinct, ranked by `GREATEST(ts_rank, 0.01)`.

### 2. Ranking

Results are ordered by `rank DESC`. The rank value (0.0–1.0) is exposed as `_search_rank` in the API response. The frontend shows "85% match" for results with rank > 0.05.

High rank = the search query appears in multiple fields or in exact form.
Low rank (0.01) = only matched via ILIKE substring.

### 3. Indexing

A GIN (Generalized Inverted Index) was added to the `receipts` table:
```sql
CREATE INDEX idx_receipts_search ON receipts
USING GIN (to_tsvector('simple',
    COALESCE(supplier,'') || ' ' ||
    COALESCE(category,'') || ' ' ||
    COALESCE(invoice_number,'') || ' ' ||
    COALESCE(kra_pin,'') || ' ' ||
    COALESCE(buyer_kra_pin,'') || ' ' ||
    COALESCE(cu_invoice,'') || ' ' ||
    COALESCE(batch_title,'') || ' ' ||
    COALESCE(total_amount::text,'')
));
```

GIN indexes are optimized for full-text search — they pre-compute token positions, making `@@` queries fast even on large datasets.

### 4. Item Name Search

Item names from the `line_items` table are JOINed into the search:
```sql
LEFT JOIN line_items li ON li.receipt_id = r.id
WHERE ... li.name ILIKE '%hardware%'
```

The `string_agg(DISTINCT li.name, ', ')` aggregates matching item names for display.

### 5. Frontend Flow

```
User types in search box
  ↓
handleSearch(e) fires on every keystroke
  ↓
clearTimeout() cancels previous timer
  ↓
setTimeout(300ms) — waits for user to stop typing
  ↓
receiptApi.search(q, 25, 0) — calls backend
  ↓
setSearchResults(results) — stores results
  ↓
filteredReceipts useMemo detects searchResults !== null
  ↓
Returns searchResults sorted by _search_rank
  ↓
Sidebar list updates with matches
```

### 6. Searchable Fields

| Field | Search Method |
|-------|--------------|
| `supplier` | tsvector + ILIKE |
| `category` | tsvector + ILIKE |
| `invoice_number` | tsvector + ILIKE |
| `kra_pin` (seller) | tsvector + ILIKE |
| `buyer_kra_pin` | tsvector + ILIKE |
| `cu_invoice` | tsvector + ILIKE |
| `batch_title` | tsvector + ILIKE |
| `total_amount` | tsvector (as text) + ILIKE |
| `receipt_date` | ILIKE only |
| `item names` | ILIKE only (from line_items JOIN) |

## Intention

Replace the limited `search_receipts()` (which only filtered by supplier/category/date)
with a comprehensive search that:

1. **Searches everything** — every text field, every numeric field, every item name
2. **Shows results as you type** — 300ms debounced, no submit button needed
3. **Ranks by relevance** — exact matches first, partial matches later
4. **Works for partial matches** — type "hard" to find "Hardware", "HARDWARE", "hardware"
5. **Single query** — no client-side filtering, all work done in PostgreSQL

## API Contract

```
GET /api/v1/users/{userId}/receipts/search
  ?q=hardware          (required, min 1 char)
  &limit=25            (optional, default 50, max 100)
  &offset=0            (optional, default 0)

Response:
{
  "total": 183,
  "results": [
    {
      ...receipt fields...,
      "_search_rank": 0.076,
      "_item_names": "PVC Pipe, Cement"
    }
  ]
}
```

Requires authentication (Bearer token). Multi-tenant — results are scoped to `user_id`.
