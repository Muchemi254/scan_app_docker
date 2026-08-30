"""Add file_type + pdf_page_count to receipts for PDF support

Revision ID: 021
Revises: 020
Create Date: 2026-08-30
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "021"
down_revision: Union[str, None] = "020"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "receipts",
        sa.Column("file_type", sa.String(length=32), nullable=True),
    )
    op.add_column(
        "receipts",
        sa.Column("pdf_page_count", sa.Integer(), nullable=True),
    )
    # Existing rows with a stored image are JPEGs (the only format the old
    # pipeline wrote). Rows without an image keep NULL so hasImage-style
    # semantics stay unambiguous.
    op.execute(
        "UPDATE receipts SET file_type = 'image/jpeg' "
        "WHERE file_type IS NULL AND image_filename IS NOT NULL"
    )


def downgrade() -> None:
    op.drop_column("receipts", "pdf_page_count")
    op.drop_column("receipts", "file_type")
