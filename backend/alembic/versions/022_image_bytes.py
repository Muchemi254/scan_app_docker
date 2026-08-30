"""Mirror receipt image bytes into Postgres for rebuild-proof storage

Revision ID: 022
Revises: 021
Create Date: 2026-08-30
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "022"
down_revision: Union[str, None] = "021"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Image bytes live in the image_data volume AND are mirrored here so a
    # wiped/emptied volume self-heals from the database (pgdata) at boot —
    # rebuilds can never lose images. Backfill happens at boot via
    # self_heal_image_files() (needs IMAGE_STORAGE_DIR + app config, not
    # available reliably inside alembic).
    op.add_column(
        "receipts",
        sa.Column("image_bytes", sa.LargeBinary(), nullable=True),
    )
    op.add_column(
        "receipts",
        sa.Column("thumb_bytes", sa.LargeBinary(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("receipts", "thumb_bytes")
    op.drop_column("receipts", "image_bytes")
