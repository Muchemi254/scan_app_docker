"""Uppercase supplier names + categories (dedupe rule).

Revision ID: 027
Revises: 026

Supplier names were extracted in mixed case ("Acme", "ACME", "acme"),
splitting one supplier into several rows in breakdowns/exports. Categories
had the same problem across the Title Case taxonomy.

From here on every write path uppercases both fields
(text_normalize + gemini extraction + Pydantic validators + database_service).
This migration converges existing rows:

  - receipts.supplier → collapsed-whitespace UPPER, empty → 'UNKNOWN'
  - receipts.category → collapsed-whitespace UPPER (NULL/empty left alone)
  - categories.name / categories.label → collapsed-whitespace UPPER

Safe under the existing unique indexes: categories carry both
uq_categories_industry_name (case-sensitive) and
uq_categories_industry_lower_name (industry_id, lower(name)). Two rows that
would collide after UPPER() already collide on lower(name) today, so the DB
cannot hold such a pair — no dedupe step needed.
"""
from typing import Sequence, Union

from alembic import op

revision: str = "027"
down_revision: Union[str, None] = "026"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Empty suppliers → UNKNOWN (column is NOT NULL; blanks are meaningless).
    op.execute(
        "UPDATE receipts SET supplier = 'UNKNOWN' "
        "WHERE NULLIF(BTRIM(COALESCE(supplier, '')), '') IS NULL"
    )
    # 2. Collapse whitespace runs + uppercase suppliers.
    op.execute(
        "UPDATE receipts SET supplier = UPPER(BTRIM(REGEXP_REPLACE(supplier, '\\s+', ' ', 'g'))) "
        "WHERE supplier <> UPPER(BTRIM(REGEXP_REPLACE(supplier, '\\s+', ' ', 'g')))"
    )
    # 3. Collapse whitespace runs + uppercase category snapshots.
    op.execute(
        "UPDATE receipts SET category = UPPER(BTRIM(REGEXP_REPLACE(category, '\\s+', ' ', 'g'))) "
        "WHERE category IS NOT NULL AND BTRIM(category) <> '' "
        "AND category <> UPPER(BTRIM(REGEXP_REPLACE(category, '\\s+', ' ', 'g')))"
    )
    # 4. Admin-managed category taxonomy → UPPERCASE names + labels.
    op.execute(
        "UPDATE categories SET "
        "name = UPPER(BTRIM(REGEXP_REPLACE(name, '\\s+', ' ', 'g'))), "
        "label = UPPER(BTRIM(REGEXP_REPLACE(label, '\\s+', ' ', 'g'))), "
        "updated_at = now() "
        "WHERE name <> UPPER(BTRIM(REGEXP_REPLACE(name, '\\s+', ' ', 'g'))) "
        "OR label <> UPPER(BTRIM(REGEXP_REPLACE(label, '\\s+', ' ', 'g')))"
    )


def downgrade() -> None:
    # Data migration — not reversible: the uppercase rule is enforced on
    # every write path, so restoring mixed case would immediately diverge
    # again. Restore from backup if a rollback is ever needed.
    pass
