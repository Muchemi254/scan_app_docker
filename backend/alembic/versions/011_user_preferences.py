"""Add per-user tax preference (default tax rate).

Each user can set their own default VAT/tax rate in Settings (initially 16% —
mirrors the seeded global default_tax_rate in app_settings). That value is
the fallback used when computing item-level tax in the receipt editor, and it
can be overridden per receipt (receipts.tax_rate) and per line item
(line_items.tax_rate).

Resolution order for an item's effective rate:
  line_items.tax_rate → receipts.tax_rate → user default → global default → 16

Revision ID: 011
Revises: 010
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "011"
down_revision: Union[str, None] = "010"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "user_preferences",
        sa.Column("user_id", sa.Text(), primary_key=True),
        sa.Column("default_tax_rate", sa.Numeric(5, 2), nullable=False, server_default="16"),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_foreign_key(
        "fk_user_preferences_uid", "user_preferences", "users", ["user_id"], ["uid"],
        ondelete="CASCADE",
    )


def downgrade() -> None:
    op.drop_table("user_preferences")