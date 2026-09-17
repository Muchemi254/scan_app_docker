"""Staged receipt images: server-processed images awaiting attachment.

Revision ID: 029
Revises: 028

When a user adds images to a receipt, the file is first sent to the server,
run through the same image pipeline as stored images (magic-byte validation,
HEIC→JPEG, EXIF rotate, resize, thumbnail) and recorded here as a
"staged" image. The modal then displays the PROCESSED thumbnail (never the
raw local file) with a processing indicator. Saving the receipt promotes the
staged rows into ``receipt_images`` (same id/filenames) and deletes the
staging row. A periodic sweep removes stale staged rows/files.

Ownership is per user; rows are never attached to a receipt until promoted.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "029"
down_revision: Union[str, None] = "028"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "staged_receipt_images",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("image_filename", sa.Text(), nullable=True),
        sa.Column("thumbnail_filename", sa.Text(), nullable=True),
        sa.Column("file_type", sa.String(32), nullable=True),
        sa.Column("pdf_page_count", sa.Integer(), nullable=True),
        sa.Column("image_sha256", sa.String(64), nullable=True),
        sa.Column("image_bytes", sa.LargeBinary(), nullable=True),
        sa.Column("thumb_bytes", sa.LargeBinary(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
    )
    op.create_index("idx_staged_receipt_images_user", "staged_receipt_images", ["user_id"])
    op.create_index("idx_staged_receipt_images_created", "staged_receipt_images", ["created_at"])


def downgrade() -> None:
    op.drop_index("idx_staged_receipt_images_created", table_name="staged_receipt_images")
    op.drop_index("idx_staged_receipt_images_user", table_name="staged_receipt_images")
    op.drop_table("staged_receipt_images")
