"""Add image_sha256 column + per-user unique index for dedup

Revision ID: 002
Revises: 001
Create Date: 2026-06-14
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "002"
down_revision: Union[str, None] = "001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "receipts",
        sa.Column("image_sha256", sa.String(length=64), nullable=True),
    )
    # Partial unique index — only enforced when image_sha256 is non-null,
    # so legacy receipts without a hash are unaffected. Scoped per user so
    # two users uploading the same image still each get their own copy.
    op.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS uq_receipts_user_image_sha256
        ON receipts (user_id, image_sha256)
        WHERE image_sha256 IS NOT NULL
        """
    )
    op.create_index(
        "idx_receipts_image_sha256",
        "receipts",
        ["image_sha256"],
    )


def downgrade() -> None:
    op.drop_index("idx_receipts_image_sha256", table_name="receipts")
    op.execute("DROP INDEX IF EXISTS uq_receipts_user_image_sha256")
    op.drop_column("receipts", "image_sha256")
