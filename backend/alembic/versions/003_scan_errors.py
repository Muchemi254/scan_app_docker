"""Add scan_errors table for durable, user-reviewable extraction failures.

The Redis batch state is live-view only and expires after 24h. This table
persists what went wrong (quota/auth/save failures per chunk/item) so users
can review errors after the batch has been dismissed or expired.

Revision ID: 003
Revises: 002
Create Date: 2026-08-13
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "003"
down_revision: Union[str, None] = "002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "scan_errors",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False, server_default="batch"),
        sa.Column("code", sa.Text(), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=True),
        sa.Column("batch_id", sa.Text(), nullable=True),
        sa.Column("item_index", sa.Integer(), nullable=True),
        sa.Column("receipt_id", sa.Text(), nullable=True),
        sa.Column(
            "data",
            sa.JSON(),
            nullable=False,
            server_default=sa.text("'{}'::jsonb"),
        ),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "idx_scan_errors_user_created",
        "scan_errors",
        ["user_id", "created_at"],
    )
    op.create_index(
        "idx_scan_errors_user_unread",
        "scan_errors",
        ["user_id", "read_at"],
    )


def downgrade() -> None:
    op.drop_index("idx_scan_errors_user_unread", table_name="scan_errors")
    op.drop_index("idx_scan_errors_user_created", table_name="scan_errors")
    op.drop_table("scan_errors")