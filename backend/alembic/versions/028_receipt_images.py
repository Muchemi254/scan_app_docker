"""Per-receipt multiple images: receipt_images child table.

Revision ID: 028
Revises: 027

A receipt now holds 1..N image/PDF files. Each file is one row in
``receipt_images`` (ordered by ``sort_order``), with its own disk file,
thumbnail, sha256 and rebuild-proof byte mirror. The ``receipts`` image
columns (image_filename, file_type, image_sha256, image_bytes, thumb_bytes,
pdf_page_count) remain as a denormalized COVER = first image so existing
consumers (backup, reports, messages, group thumbnails) keep working.

Backfill: every existing receipt with a stored file gets one child row
(sort_order 0) pointing at the existing ``{receipt_id}.jpg|.pdf`` file and
its ``{receipt_id}_thumb.jpg`` thumbnail.

Dedup uniqueness moves from ``receipts(user_id, image_sha256)`` to the child
table so a receipt may carry several distinct images.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "028"
down_revision: Union[str, None] = "027"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "receipt_images",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "receipt_id",
            sa.Text(),
            sa.ForeignKey("receipts.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("user_id", sa.Text(), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("image_filename", sa.Text(), nullable=True),
        sa.Column("thumbnail_filename", sa.Text(), nullable=True),
        sa.Column("file_type", sa.String(32), nullable=True),
        sa.Column("pdf_page_count", sa.Integer(), nullable=True),
        sa.Column("image_sha256", sa.String(64), nullable=True),
        sa.Column("image_bytes", sa.LargeBinary(), nullable=True),
        sa.Column("thumb_bytes", sa.LargeBinary(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.UniqueConstraint("receipt_id", "sort_order", name="uq_receipt_images_receipt_sort"),
    )
    op.create_index("idx_receipt_images_receipt", "receipt_images", ["receipt_id"])
    op.create_index("idx_receipt_images_user", "receipt_images", ["user_id"])
    op.create_index(
        "uq_receipt_images_user_sha256",
        "receipt_images",
        ["user_id", "image_sha256"],
        unique=True,
        postgresql_where=sa.text("image_sha256 IS NOT NULL"),
    )

    # Backfill one child row per existing imaged receipt. The legacy file is
    # named {receipt_id}.jpg|.pdf; keep that filename so its bytes/thumbnail
    # resolve without copying files. The thumbnail name is derived at read
    # time from the image filename, so it can stay NULL here.
    op.execute(
        """
        INSERT INTO receipt_images
            (id, receipt_id, user_id, sort_order, image_filename,
             thumbnail_filename, file_type, pdf_page_count, image_sha256,
             image_bytes, thumb_bytes, created_at)
        SELECT gen_random_uuid()::text, r.id, r.user_id, 0, r.image_filename,
               NULL, COALESCE(r.file_type, 'image/jpeg'), r.pdf_page_count,
               r.image_sha256, r.image_bytes, r.thumb_bytes, r.created_at
        FROM receipts r
        WHERE r.image_filename IS NOT NULL
          AND NULLIF(BTRIM(r.image_filename), '') IS NOT NULL
        """
    )

    # Dedup uniqueness is now per-image on the child table.
    op.execute("DROP INDEX IF EXISTS uq_receipts_user_image_sha256")


def downgrade() -> None:
    # Data migration — dropping receipt_images would lose all but the cover
    # image. Restore from backup if a rollback is ever needed.
    op.drop_index("uq_receipt_images_user_sha256", table_name="receipt_images")
    op.drop_index("idx_receipt_images_user", table_name="receipt_images")
    op.drop_index("idx_receipt_images_receipt", table_name="receipt_images")
    op.drop_table("receipt_images")
