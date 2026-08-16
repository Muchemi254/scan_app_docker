"""Add configurable tax-rate overrides.

The default VAT rate is 16% (seed). It can be adjusted globally in Settings
(app_settings key 'default_tax_rate') and overridden per receipt and per
line item so line-by-line variance (e.g. zero-rated vs 16% vs other rates)
can be captured at the most specific level.

Resolution order when computing an item's tax:
  line_items.tax_rate  ─►  receipts.tax_rate  ─►  default_tax_rate  ─►  16

Revision ID: 010
Revises: 009
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "010"
down_revision: Union[str, None] = "009"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("receipts", sa.Column("tax_rate", sa.Numeric(5, 2), nullable=True))
    op.add_column("line_items", sa.Column("tax_rate", sa.Numeric(5, 2), nullable=True))

    # Seed the global default (16%) if not already present.
    op.execute("""
        INSERT INTO app_settings (key, value)
        VALUES ('default_tax_rate', '16')
        ON CONFLICT (key) DO NOTHING
    """)


def downgrade() -> None:
    op.drop_column("line_items", "tax_rate")
    op.drop_column("receipts", "tax_rate")
    op.execute("DELETE FROM app_settings WHERE key = 'default_tax_rate'")