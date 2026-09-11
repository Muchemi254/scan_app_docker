# Category Taxonomy

Canonical receipt categories. **50 → 42** (decided 2025-XX; see
`pdf-compatibility-plan.md` for context that this repo keeps docs for design
decisions).

**Storage rule (migration `027`): supplier names and categories are always
stored UPPERCASE** (`SUPPLIER` / `CATEGORY`), so `Acme` vs `ACME` can never
split one supplier into two rows. Every write path (AI extraction, Pydantic
validators, `database_service`) uppercases both fields, and filters compare
with `UPPER(...)`.

## Canonical list (42, UPPERCASE)

```
BUILDING MATERIALS, HARDWARE & TOOLS, PAINT & FINISHES, PLUMBING & SANITARY,
ELECTRICAL SUPPLIES, SECURITY & SURVEILLANCE,
FUEL & LUBRICANTS, VEHICLE MAINTENANCE, TRANSPORT SERVICES, UTILITIES & BILLS,
SEEDS & INPUTS, FERTILIZERS & CHEMICALS, FARM TOOLS & EQUIPMENT,
GREENHOUSE SUPPLIES, CROP HARVESTING & PROCESSING, AGRO CONSULTANCY & TRAINING,
ANIMAL FEED & SUPPLEMENTS, LIVESTOCK & POULTRY, VETERINARY SERVICES,
FOOD & GROCERIES, FURNITURE & FIXTURES, UTENSILS & CUTLERY, CLEANING SUPPLIES,
BABY & KIDS SUPPLIES, CLOTHING & FOOTWEAR, PERSONAL CARE & BEAUTY,
HEALTH & MEDICINE, STATIONERY & OFFICE SUPPLIES, PROFESSIONAL & BUSINESS SERVICES,
EMPLOYEE SALARIES & WAGES, LICENSES & PERMITS, RENT, LEASE & PROPERTY,
ELECTRONICS & APPLIANCES, PHONES & ACCESSORIES, COMPUTERS & IT EQUIPMENT,
RAW MATERIALS, PACKAGING SUPPLIES, GIFTS & DONATIONS, ENTERTAINMENT & LEISURE,
REPAIRS & MAINTENANCE, EMERGENCY PURCHASES, OTHER
```

Design rules:

- **Broad by design.** Categories are buckets, not supplier names — a receipt
  must always fit. When in doubt the extractor picks the closest bucket.
- **UPPERCASE everywhere.** Canonical names, alias targets, the
  `categories` reference table and every `receipts.category` snapshot are
  uppercase. Matching is case-insensitive (`normalize_category()` uppercases
  before comparing; SQL filters use `UPPER(...)`).
- **One source of truth** is the backend list in
  `backend/app/services/gemini.py` (`CATEGORIES`); the frontend copy in
  `frontend/src/services/gemini.tsx` (`CATEGORY_LIST`) must stay identical.
- **Never grow the list.** `normalize_category()` maps model output to this
  exact list: exact match → alias → `OTHER`. New categories are a deliberate
  code change, not an extraction accident.
- **`OTHER` is a real category.** Receipts that fit nothing go to `OTHER`
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
| `" Animal Feed & Supplements"` (leading space) | ANIMAL FEED & SUPPLEMENTS |
| `building materials` (lowercase) | BUILDING MATERIALS |
| `cleaning` | CLEANING SUPPLIES |

Kept separate (deliberate): the full agro cluster, Building Materials,
Hardware & Tools, Paint & Finishes, Fuel & Lubricants, Vehicle Maintenance,
Transport Services, Health & Medicine, Electronics & Appliances, Phones &
Accessories, Computers & IT Equipment, Furniture & Fixtures, Utensils &
Cutlery, Cleaning Supplies, Baby & Kids Supplies, Gifts & Donations,
Entertainment & Leisure, Raw Materials, Packaging Supplies, Emergency
Purchases.

## Alias map (`CATEGORY_ALIASES` in `gemini.py`)

All values above plus case/whitespace variants. `normalize_category()`:

1. collapse whitespace + uppercase
2. exact match against the canonical list → return
3. lowercased match against the alias map → return canonical
4. else → `OTHER`

## Explicitly NOT a category

- **BANK DEPOSIT** (4 rows) — deposit slips are not spend. The
  non-expense/entry-type feature (`docs/non-expense-flag-plan.md`) reclassifies
  them as `entry_type='deposit'`; the taxonomy migration deliberately leaves
  them untouched.
- **Emergency Purchases** — kept as a category (user decision); "emergency" is
  a circumstance, so it may later fold into `Other`.

## Enforcement

- Extraction prompt instructs: choose EXACTLY ONE from the list, supplier +
  category in UPPERCASE, categories are broad, never invent, `OTHER` when unsure.
- `normalize_category()` runs on every extraction result (single + batch).
- Migration `019` backfills existing rows.
- Migration `027` uppercases all suppliers + categories (receipts and the
  `categories` reference table).
- Test: `backend/tests/test_category_taxonomy.py` guards aliases + list sanity.
