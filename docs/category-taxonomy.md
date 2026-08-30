# Category Taxonomy

Canonical receipt categories. **50 → 42** (decided 2025-XX; see
`pdf-compatibility-plan.md` for context that this repo keeps docs for design
decisions).

## Canonical list (42)

```
Building Materials, Hardware & Tools, Paint & Finishes, Plumbing & Sanitary,
Electrical Supplies, Security & Surveillance,
Fuel & Lubricants, Vehicle Maintenance, Transport Services, Utilities & Bills,
Seeds & Inputs, Fertilizers & Chemicals, Farm Tools & Equipment,
Greenhouse Supplies, Crop Harvesting & Processing, Agro Consultancy & Training,
Animal Feed & Supplements, Livestock & Poultry, Veterinary Services,
Food & Groceries, Furniture & Fixtures, Utensils & Cutlery, Cleaning Supplies,
Baby & Kids Supplies, Clothing & Footwear, Personal Care & Beauty,
Health & Medicine, Stationery & Office Supplies, Professional & Business Services,
Employee Salaries & Wages, Licenses & Permits, Rent, Lease & Property,
Electronics & Appliances, Phones & Accessories, Computers & IT Equipment,
Raw Materials, Packaging Supplies, Gifts & Donations, Entertainment & Leisure,
Repairs & Maintenance, Emergency Purchases, Other
```

Design rules:

- **Broad by design.** Categories are buckets, not supplier names — a receipt
  must always fit. When in doubt the extractor picks the closest bucket.
- **One source of truth** is the backend list in
  `backend/app/services/gemini.py` (`CATEGORIES`); the frontend copy in
  `frontend/src/services/gemini.tsx` (`CATEGORY_LIST`) must stay identical.
- **Never grow the list.** `normalize_category()` maps model output to this
  exact list: exact match → alias → `Other`. New categories are a deliberate
  code change, not an extraction accident.
- **`Other` is a real category.** Receipts that fit nothing go to `Other`
  instead of forcing a wrong bucket or inventing a name.

## Merges applied (migration `019_category_taxonomy`)

| Old category (DB) | Canonical |
|---|---|
| Groceries & Provisions, Perishables, Beverages, Restaurant & Catering | Food & Groceries |
| Irrigation Supplies | Plumbing & Sanitary |
| Veterinary Inputs & Services | Veterinary Services |
| Repairs & Maintenance Services, Facility maintenance services | Repairs & Maintenance |
| Energy & Utilities, Internet & Airtime | Utilities & Bills |
| Marketing & Branding, Professional Services, Subscriptions & Memberships, Education & Learning | Professional & Business Services |
| Rent & Lease, Land & Property Purchases | Rent, Lease & Property |
| `" Animal Feed & Supplements"` (leading space) | Animal Feed & Supplements |
| `building materials` (lowercase) | Building Materials |
| `cleaning` | Cleaning Supplies |

Kept separate (deliberate): the full agro cluster, Building Materials,
Hardware & Tools, Paint & Finishes, Fuel & Lubricants, Vehicle Maintenance,
Transport Services, Health & Medicine, Electronics & Appliances, Phones &
Accessories, Computers & IT Equipment, Furniture & Fixtures, Utensils &
Cutlery, Cleaning Supplies, Baby & Kids Supplies, Gifts & Donations,
Entertainment & Leisure, Raw Materials, Packaging Supplies, Emergency
Purchases.

## Alias map (`CATEGORY_ALIASES` in `gemini.py`)

All values above plus case/whitespace variants. `normalize_category()`:

1. collapse whitespace
2. exact match against the canonical list → return
3. lowercased match against the alias map → return canonical
4. else → `Other`

## Explicitly NOT a category

- **BANK DEPOSIT** (4 rows) — deposit slips are not spend. The
  non-expense/entry-type feature (`docs/non-expense-flag-plan.md`) reclassifies
  them as `entry_type='deposit'`; the taxonomy migration deliberately leaves
  them untouched.
- **Emergency Purchases** — kept as a category (user decision); "emergency" is
  a circumstance, so it may later fold into `Other`.

## Enforcement

- Extraction prompt instructs: choose EXACTLY ONE from the list, categories are
  broad, never invent, `Other` when unsure.
- `normalize_category()` runs on every extraction result (single + batch).
- Migration `019` backfills existing rows.
- Test: `backend/tests/test_category_taxonomy.py` guards aliases + list sanity.
