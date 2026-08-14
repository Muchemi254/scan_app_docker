"""Add durable scan sessions + per-item state for the hold/manual-dispatch flow

scan_sessions is the durable replacement for the old Redis batch state: local
prep ends in status='prepared' (holding), AI is dispatched explicitly by the
user per group. Item-level state lives in scan_session_items; chunk-level
runtime state (Gemini batching, retry attempts) lives in scan_sessions.chunks.

Revision ID: 006
Revises: 005
Create Date: 2026-08-14
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "006"
down_revision: Union[str, None] = "005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "scan_sessions",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column(
            "status", sa.Text(), nullable=False, server_default="uploading"
        ),
        sa.Column("image_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("group_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "chunks", sa.JSON(), nullable=False, server_default=sa.text("'[]'::jsonb")
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("idx_scan_sessions_user", "scan_sessions", ["user_id", sa.text("created_at DESC")])

    op.create_table(
        "scan_session_items",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "session_id", sa.Text(), sa.ForeignKey("scan_sessions.id", ondelete="CASCADE"), nullable=False
        ),
        sa.Column("item_index", sa.Integer(), nullable=False),
        sa.Column("orig_filename", sa.Text(), nullable=True),
        sa.Column("image_filename", sa.Text(), nullable=True),
        sa.Column("mime", sa.Text(), nullable=True),
        sa.Column("image_sha256", sa.Text(), nullable=True),
        sa.Column("group_index", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("chunk_index", sa.Integer(), nullable=True),
        sa.Column(
            "status", sa.Text(), nullable=False, server_default="pending"
        ),
        sa.Column("stage", sa.Text(), nullable=True),
        sa.Column("message", sa.Text(), nullable=True),
        sa.Column("error_code", sa.Text(), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("receipt_id", sa.Text(), nullable=True),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("session_id", "item_index"),
    )
    op.create_index("idx_scan_items_session", "scan_session_items", ["session_id"])
    op.create_index("idx_scan_items_status", "scan_session_items", ["session_id", "status"])


def downgrade() -> None:
    op.drop_index("idx_scan_items_status", table_name="scan_session_items")
    op.drop_index("idx_scan_items_session", table_name="scan_session_items")
    op.drop_table("scan_session_items")
    op.drop_index("idx_scan_sessions_user", table_name="scan_sessions")
    op.drop_table("scan_sessions")
