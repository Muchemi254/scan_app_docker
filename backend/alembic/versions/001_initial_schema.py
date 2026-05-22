"""Initial schema — receipts, line_items, audit_logs, tasks, ui_settings, review_batches

Revision ID: 001
Revises:
Create Date: 2026-05-22
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── receipts ──────────────────────────────────────────────────────────
    op.create_table(
        "receipts",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="processed"),
        sa.Column("supplier", sa.Text(), nullable=False),
        sa.Column("total_amount", sa.Numeric(12, 2), nullable=False, server_default="0"),
        sa.Column("tax_amount", sa.Numeric(12, 2), nullable=True),
        sa.Column("receipt_date", sa.Date(), nullable=False),
        sa.Column("category", sa.Text(), nullable=True),
        sa.Column("invoice_number", sa.Text(), nullable=True),
        sa.Column("kra_pin", sa.Text(), nullable=True),
        sa.Column("cu_invoice", sa.Text(), nullable=True),
        sa.Column("batch_title", sa.Text(), nullable=True),
        sa.Column("image_filename", sa.Text(), nullable=True),
        sa.Column("thumbnail_filename", sa.Text(), nullable=True),
        sa.Column("legacy_image_url", sa.Text(), nullable=True),
        sa.Column("scanned_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("idx_receipts_user_id", "receipts", ["user_id"])
    op.create_index("idx_receipts_user_status", "receipts", ["user_id", "status"])
    op.create_index("idx_receipts_user_category", "receipts", ["user_id", "category"])
    op.create_index("idx_receipts_user_batch", "receipts", ["user_id", "batch_title"])
    op.create_index("idx_receipts_user_date", "receipts", ["user_id", "receipt_date"])
    op.create_index("idx_receipts_user_supplier", "receipts", ["user_id", "supplier"])
    op.create_index("idx_receipts_user_invoice", "receipts", ["user_id", "invoice_number"])

    # ── line_items ────────────────────────────────────────────────────────
    op.create_table(
        "line_items",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("receipt_id", sa.Text(), sa.ForeignKey("receipts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("quantity", sa.Numeric(10, 2), nullable=False),
        sa.Column("price", sa.Numeric(12, 2), nullable=False),
        sa.Column("tax", sa.Numeric(12, 2), nullable=True, server_default="0"),
        sa.Column("is_zero_rated", sa.Boolean(), nullable=False, server_default=sa.text("FALSE")),
        sa.Column("discount", sa.Numeric(5, 2), nullable=True),
    )
    op.create_index("idx_line_items_receipt", "line_items", ["receipt_id", "sort_order"])
    op.create_unique_constraint("uq_line_items_receipt_sort", "line_items", ["receipt_id", "sort_order"])

    # ── audit_logs ────────────────────────────────────────────────────────
    op.create_table(
        "audit_logs",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("receipt_id", sa.Text(), sa.ForeignKey("receipts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("action", sa.Text(), nullable=False),
        sa.Column("changed_by", sa.Text(), nullable=False),
        sa.Column("timestamp", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("changes", sa.JSON(), nullable=False, server_default=sa.text("'[]'::jsonb")),
    )
    op.create_index("idx_audit_receipt", "audit_logs", ["receipt_id", sa.text("timestamp DESC")])
    op.create_index("idx_audit_user", "audit_logs", ["user_id"])

    # ── tasks ─────────────────────────────────────────────────────────────
    op.create_table(
        "tasks",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("task_type", sa.Text(), nullable=False),
        sa.Column("batch_title", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="queued"),
        sa.Column("total_items", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("completed_items", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("current_step", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_steps", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("percentage", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("message", sa.Text(), nullable=False, server_default=""),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("metadata", sa.JSON(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("results", sa.JSON(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("idx_tasks_user_id", "tasks", ["user_id"])
    op.create_index("idx_tasks_status", "tasks", ["user_id", "status"])
    op.create_index("idx_tasks_created", "tasks", ["user_id", sa.text("created_at DESC")])

    # ── user_ai_settings ──────────────────────────────────────────────────
    op.create_table(
        "user_ai_settings",
        sa.Column("user_id", sa.Text(), primary_key=True),
        sa.Column("provider", sa.Text(), nullable=False, server_default="gemini"),
        sa.Column("model_id", sa.Text(), nullable=False, server_default="gemini-3-flash-preview"),
        sa.Column("configs", sa.JSON(), nullable=False, server_default=sa.text("'{}'::jsonb")),
    )

    # ── review_batches ────────────────────────────────────────────────────
    op.create_table(
        "review_batches",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("csv_filename", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("idx_review_batches_user", "review_batches", ["user_id", sa.text("created_at DESC")])

    # ── review_batch_items ────────────────────────────────────────────────
    op.create_table(
        "review_batch_items",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("batch_id", sa.Text(), sa.ForeignKey("review_batches.id", ondelete="CASCADE"), nullable=False),
        sa.Column("receipt_id", sa.Text(), nullable=False),
        sa.Column("review_status", sa.Text(), nullable=False, server_default="pending_review"),
        sa.Column("reviewer_notes", sa.Text(), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("batch_id", "receipt_id"),
    )
    op.create_index("idx_review_items_batch", "review_batch_items", ["batch_id"])
    op.create_index("idx_review_items_receipt", "review_batch_items", ["receipt_id"])


def downgrade() -> None:
    op.drop_table("review_batch_items")
    op.drop_table("review_batches")
    op.drop_table("user_ai_settings")
    op.drop_table("tasks")
    op.drop_table("audit_logs")
    op.drop_table("line_items")
    op.drop_table("receipts")
