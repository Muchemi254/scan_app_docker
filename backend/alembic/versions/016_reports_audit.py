"""Allow system-level audit entries (report exports, etc.) without a receipt.

``audit_logs.receipt_id`` was NOT NULL with an FK to receipts, which forced
every audit entry to reference a receipt.  Reports exports are audited with
``AuditAction.REPORT_EXPORT`` and have no receipt — relax the column so the
audit trail can cover system actions too.  The FK is kept (deleting a
receipt still cascades its entries).

Revision ID: 016
Revises: 015
Create Date: 2026-08-17
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "016"
down_revision: Union[str, None] = "015"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column("audit_logs", "receipt_id", nullable=True)


def downgrade() -> None:
    op.alter_column("audit_logs", "receipt_id", nullable=False)