"""Non-expense flag: entry_type column + BANK DEPOSIT backfill.

Revision ID: 020
Revises: 019
"""
from typing import Sequence, Union

from alembic import op


revision: str = "020"
down_revision: Union[str, None] = "019"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE receipts ADD COLUMN entry_type VARCHAR(20) "
        "NOT NULL DEFAULT 'expense'"
    )
    # Deposit slips scanned as receipts are not spend — keep the rows, flag them.
    op.execute(
        "UPDATE receipts SET entry_type = 'deposit' WHERE category = 'BANK DEPOSIT'"
    )
    op.create_index("idx_receipts_entry_type", "receipts", ["entry_type"])


def downgrade() -> None:
    op.drop_index("idx_receipts_entry_type", table_name="receipts")
    op.drop_column("receipts", "entry_type")
