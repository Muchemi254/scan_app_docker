"""Tenant-isolation hardening: RLS support on scan_session_items + user_ai_settings

scan_session_items previously had no user_id column, so Row-Level Security
could not be applied — a direct DB connection could read any user's items
through the session FK. This migration adds and backfills user_id, then
database.py enables RLS on both scan_session_items and user_ai_settings at
pool init (user_ai_settings already had user_id from 001_initial_schema).

Revision ID: 007
Revises: 006
Create Date: 2026-08-15
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "007"
down_revision: Union[str, None] = "006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "scan_session_items",
        sa.Column("user_id", sa.Text(), nullable=True),
    )
    op.execute(
        """
        UPDATE scan_session_items AS i
        SET user_id = s.user_id
        FROM scan_sessions AS s
        WHERE i.session_id = s.id
        """
    )
    op.alter_column("scan_session_items", "user_id", nullable=False)
    op.create_index("idx_scan_items_user", "scan_session_items", ["user_id"])


def downgrade() -> None:
    op.drop_index("idx_scan_items_user", table_name="scan_session_items")
    op.drop_column("scan_session_items", "user_id")