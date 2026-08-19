"""Reserve the inbox for crucial communication.

Workflow events that are purely informational — submit / recall / approve —
used to auto-message a bubble per receipt into the inbox (1000 receipts =
1000 inbox messages). Those events are visible on the approvals pages, so
they no longer notify anyone. This migration removes the historical bubbles
and the conversations left behind without any message.

Rejection messages (kind=receipt_rejection) are the one crucial auto-message
and are intentionally kept.

Revision ID: 017
Revises: 016
"""
from typing import Sequence, Union

from alembic import op

revision: str = "017"
down_revision: Union[str, None] = "016"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute(
        "DELETE FROM messages "
        "WHERE kind IN ('receipt_submit', 'receipt_recall', 'receipt_approval')"
    )
    op.execute(
        "DELETE FROM conversations c "
        "WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id)"
    )


def downgrade() -> None:
    # Nothing to restore: the deleted bubbles cannot be recreated faithfully.
    pass
