"""Category taxonomy: merge similar categories into the canonical 42.

Revision ID: 019
Revises: 018
"""
from typing import Sequence, Union

from alembic import op


revision: str = "019"
down_revision: Union[str, None] = "018"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# Old DB value → canonical category (see docs/category-taxonomy.md).
# BANK DEPOSIT is deliberately NOT here — it is handled by the
# non-expense/entry-type feature, not by the taxonomy.
RENAMES = [
    ("Groceries & Provisions", "Food & Groceries"),
    ("Perishables", "Food & Groceries"),
    ("Beverages", "Food & Groceries"),
    ("Restaurant & Catering", "Food & Groceries"),
    ("Irrigation Supplies", "Plumbing & Sanitary"),
    ("Veterinary Inputs & Services", "Veterinary Services"),
    ("Repairs & Maintenance Services", "Repairs & Maintenance"),
    ("Facility maintenance services", "Repairs & Maintenance"),
    ("Energy & Utilities", "Utilities & Bills"),
    ("Internet & Airtime", "Utilities & Bills"),
    ("Marketing & Branding", "Professional & Business Services"),
    ("Professional Services", "Professional & Business Services"),
    ("Subscriptions & Memberships", "Professional & Business Services"),
    ("Education & Learning", "Professional & Business Services"),
    ("Rent & Lease", "Rent, Lease & Property"),
    ("Land & Property Purchases", "Rent, Lease & Property"),
    (" Animal Feed & Supplements", "Animal Feed & Supplements"),
    ("building materials", "Building Materials"),
    ("cleaning", "Cleaning Supplies"),
]


def upgrade() -> None:
    if not RENAMES:
        return
    whens = " ".join(f"WHEN '{old}' THEN '{new}'" for old, new in RENAMES)
    olds = ", ".join(f"'{old}'" for old, _ in RENAMES)
    op.execute(
        f"UPDATE receipts SET category = CASE category {whens} ELSE category END "
        f"WHERE category IN ({olds})"
    )


def downgrade() -> None:
    # Data migration — not reversible: canonical names are also used by new
    # receipts, so reversing would mislabel them. Run a restore from backup
    # instead if a rollback is ever needed.
    pass
