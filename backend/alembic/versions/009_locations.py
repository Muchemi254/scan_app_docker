"""Add admin-managed receipt locations.

A receipt's location is a manual attribute (never AI-extracted) chosen from
an admin-managed list. Add the reference table plus a nullable snapshot column
on receipts, then backfill every existing 'processed' receipt with a default
'Unassigned' location so the new invariant holds without re-approving history:

  processed  ⟹  location IS NOT NULL

Rule split (deliberate): submitting for approval is allowed with an empty
location; only finalizing (any path into 'processed') requires one.

Revision ID: 009
Revises: 008
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "009"
down_revision: Union[str, None] = "008"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── admin-managed locations reference table (global, not tenant-scoped) ──
    op.create_table(
        "locations",
        sa.Column("id", sa.Text(), primary_key=True, server_default=sa.text("gen_random_uuid()::text")),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("TRUE")),
        sa.Column("created_by", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("idx_locations_name", "locations", ["name"], unique=True)
    op.create_index("idx_locations_active", "locations", ["is_active"])

    # Default bucket so migrated history stays valid.
    op.execute("""
        INSERT INTO locations (name, created_by)
        VALUES ('Unassigned', 'system')
        ON CONFLICT DO NOTHING
    """)

    # ── snapshot column on receipts ──────────────────────────────────────────
    op.add_column("receipts", sa.Column("location", sa.Text(), nullable=True))
    op.create_index("idx_receipts_user_location", "receipts", ["user_id", "location"])

    # Backfill only finalized receipts — pending/review entries stay empty so
    # they must be assigned a real location before approval.
    op.execute("""
        UPDATE receipts
           SET location = 'Unassigned'
         WHERE status = 'processed'
           AND (location IS NULL OR location = '')
    """)


def downgrade() -> None:
    op.drop_index("idx_receipts_user_location", table_name="receipts")
    op.drop_column("receipts", "location")
    op.drop_index("idx_locations_active", table_name="locations")
    op.drop_index("idx_locations_name", table_name="locations")
    op.drop_table("locations")