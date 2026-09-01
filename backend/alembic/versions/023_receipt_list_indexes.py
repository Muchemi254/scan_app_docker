"""Query-performance indexes for receipt lists + dashboard analytics

Revision ID: 023
Revises: 022
Create Date: 2026-09-01
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "023"
down_revision: Union[str, None] = "022"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # The default receipts list sorts every user row by created_at on each
    # request (ORDER BY created_at DESC + OFFSET pagination) — previously an
    # unindexed sort over the user's whole history.
    op.create_index(
        "idx_receipts_user_created",
        "receipts",
        ["user_id", sa.text("created_at DESC")],
    )
    # Dashboard/cleaning filter user + entry_type='expense' ORDER BY
    # created_at DESC (replaces the standalone idx_receipts_entry_type,
    # which cannot serve the sort).
    op.create_index(
        "idx_receipts_user_entry_created",
        "receipts",
        ["user_id", "entry_type", sa.text("created_at DESC")],
    )


def downgrade() -> None:
    op.drop_index("idx_receipts_user_entry_created", table_name="receipts")
    op.drop_index("idx_receipts_user_created", table_name="receipts")
