"""Track backup integrity: image_count + missing_images on the backups rows.

A "tiny backup" (data but zero images) is a silent data-loss symptom: the
export succeeded but the receipt images were absent from storage. Persist how
many images each backup actually packed and how many *referenced* images were
missing from disk at export time, so the UI can flag backups that
silently contain no images.

Revision ID: 013
Revises: 012
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "013"
down_revision: Union[str, None] = "012"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "backups",
        sa.Column(
            "image_count",
            sa.BigInteger(),
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "backups",
        sa.Column(
            "missing_images",
            sa.BigInteger(),
            nullable=False,
            server_default="0",
        ),
    )


def downgrade() -> None:
    op.drop_column("backups", "missing_images")
    op.drop_column("backups", "image_count")