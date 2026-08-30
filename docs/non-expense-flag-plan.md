# Non-Expense Flag (Entry Type) Plan

Goal: let users flag receipts that are **not expenses** — quotations,
proformas, deposit slips, or general notes — so they are **retained** (never
deleted), **excluded from totals and exports**, still visible in the UI, and
reportable separately. Trigger: the 4 `BANK DEPOSIT` receipts made it clear
that not everything scanned is spend.

## Semantics

- Every receipt gets an `entry_type`: `expense` (default) | `quotation` |
  `proforma` | `deposit` | `note`.
- A non-expense receipt is a normal receipt row: it keeps its image, items,
  category, audit trail, review/approval state. Nothing is deleted.
- Flagging is **manual** (review panel, form, edit) — AI does not decide
  entry type (a wrong AI guess is worse than a manual flag; the user asked for
  manual control).
- Flagging is **reversible** (change `expense` ↔ other at any time).
- **BANK DEPOSIT** rows (4) are backfilled to `entry_type='deposit'` in
  migration `020`; their category value is left untouched.

## Where non-expense entries are excluded

| Surface | Behavior |
|---|---|
| Dashboard KPIs / trends / breakdown / insights | excluded (fetch only `entry_type='expense'`) |
| Receipt group totals (gallery batches) | excluded (SQL condition) |
| Exports (server + client) | excluded by default; `includeNonExpense` / `entryType` options to include or isolate |
| Spending/category/supplier/tax/monthly reports | excluded (`expense_cond` on receipt report defs) |
| Receipt register report | shows all rows + a new `entry_type` column |
| Lists / search / gallery | **shown** with an entry-type badge (so users can see and manage them) |

## Exports & the non-expense register

- Server export (`POST /receipts/export`): `includeNonExpense` (default
  false) and `entryType` (expense | quotation | proforma | deposit | note |
  non_expense) query fields. Explicit `entryType` wins over the default
  exclusion → "non-expense register export" = `entryType=non_expense`.
- Client-side export: same filtering applied in `export.ts` before
  generating files.
- Export page: "Entry type" select (All / Expenses only / Non-expense /
  Quotation / Proforma / Deposit / Note) + "Include non-expense entries"
  checkbox for the default export.

## UI

- `ReceiptForm`: entry-type select (Expense / Quotation / Proforma / Deposit
  / Note), default Expense.
- `ReviewPanel`: entry-type row with a colored badge; edit flow uses
  ReceiptForm.
- Gallery cards: badge (`Quotation`, `Proforma`, `Deposit`, `Note`) on
  non-expense entries.
- Receipt detail: badge via ReviewPanel.

## Schema / migration

- `020_entry_type`: `ALTER TABLE receipts ADD COLUMN entry_type VARCHAR(20)
  NOT NULL DEFAULT 'expense'`; backfill `BANK DEPOSIT` → `deposit`; index on
  `entry_type`.
- Pydantic: `EntryType` enum; `entryType` on `ReceiptCreate` (default
  expense), `ReceiptUpdate`, `Receipt` response.

## Testing

- Create with each entry type; list filter (`expense`, specific type,
  `non_expense`); update toggles; dashboard fetch excludes; groups totals
  exclude; export default excludes + `includeNonExpense` includes +
  `entryType=non_expense` isolates; register report carries the column.

## Deferred

- Firestore (legacy `AUTH_MODE=firebase`) parity for `entry_type`.
- AI-assisted entry-type suggestion (manual flag stays authoritative).
- Bulk flagging actions in list views.
