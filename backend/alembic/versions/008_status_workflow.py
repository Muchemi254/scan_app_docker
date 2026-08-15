"""Adopt the controlled review→approval status pipeline.

- Fold the legacy admin-only 'super_processed' status into 'processed'
  (an admin already finalized those receipts — no re-approval needed).
- Normalise any other unknown status back to 'needs_review' so every
  receipt lands in a known bucket of the new pipeline.

Pipeline: needs_review → pending_approval → processed.
No schema change — status is a text column.

Revision ID: 008
Revises: 007
"""
from typing import Sequence, Union

from alembic import op


revision: str = "008"
down_revision: Union[str, None] = "007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "UPDATE receipts SET status = 'processed' WHERE status = 'super_processed'"
    )
    op.execute(
        "UPDATE receipts SET status = 'needs_review' "
        "WHERE status NOT IN ('processed', 'needs_review', 'pending_approval')"
    )


def downgrade() -> None:
    # Data-only remap is not reversible without extra metadata; leave as-is.
    pass
