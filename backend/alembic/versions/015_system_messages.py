"""Allow senderless system messages in chat threads.

Receipt-scoped system events (e.g. scan errors mirrored into the receipt's
chat thread) come from the platform, not from a user — so messages.sender_id
becomes nullable. The service layer posts those with sender_id = NULL; the
frontend renders them with the "System" header and never treats them as
"mine" (sender_id !== current uid).

Revision ID: 015
Revises: 014
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "015"
down_revision: Union[str, None] = "014"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.alter_column(
        "messages",
        "sender_id",
        existing_type=sa.Text(),
        nullable=True,
    )


def downgrade() -> None:
    # Restore NOT NULL; senderless system messages must be removed first or
    # the constraint fails.
    op.execute("DELETE FROM messages WHERE sender_id IS NULL")
    op.alter_column(
        "messages",
        "sender_id",
        existing_type=sa.Text(),
        nullable=False,
    )
