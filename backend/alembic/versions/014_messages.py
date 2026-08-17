"""User ↔ admin messaging (conversations + messages).

Backs the in-app message center: a durable, read/unread conversation
system shared by system events (e.g. rejection auto-messages) and
user ↔ admin support chat. Conversations are strictly 1:1 pairs (plus an
optional receipt_id thread context), participants enforce user ↔ admin
only, and both tables get row-level security via the app-wide
app.current_user_id mechanism so a user can never read another tenant's
threads — even with a raw SQL connection.

Revision ID: 014
Revises: 013
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = "014"
down_revision: Union[str, None] = "013"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_RLS_FUNC_SQL = r"""
CREATE OR REPLACE FUNCTION app_is_conversation_participant(conv_id uuid) RETURNS boolean
LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT EXISTS (
        SELECT 1 FROM conversations c
        WHERE c.id = conv_id
          AND (
            c.user_a = current_setting('app.current_user_id', true)
            OR c.user_b = current_setting('app.current_user_id', true)
          )
    )
$$;
"""


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE conversations (
            id UUID PRIMARY KEY,
            user_a TEXT NOT NULL,
            user_b TEXT NOT NULL,
            receipt_id UUID NULL,
            kind TEXT NOT NULL DEFAULT 'pair',
            last_message_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            CONSTRAINT uq_conversation_pair UNIQUE (user_a, user_b, receipt_id),
            CONSTRAINT chk_pair_ordered CHECK (user_a < user_b)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE messages (
            id UUID PRIMARY KEY,
            conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            sender_id TEXT NOT NULL,
            recipient_id TEXT NOT NULL,
            body TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'message',
            payload JSONB NULL,
            read_at TIMESTAMPTZ NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )
    op.execute(
        "CREATE INDEX idx_conversations_user_a ON conversations (user_a, last_message_at DESC)"
    )
    op.execute(
        "CREATE INDEX idx_conversations_user_b ON conversations (user_b, last_message_at DESC)"
    )
    op.execute(
        "CREATE INDEX idx_messages_conversation ON messages (conversation_id, created_at)"
    )
    op.execute(
        "CREATE INDEX idx_messages_unread ON messages (recipient_id, read_at) WHERE read_at IS NULL"
    )

    # ── Row-level security (defense in depth behind the service layer) ─────
    # NOTE: the app connects as the `scanapp` superuser, which bypasses RLS
    # regardless of ENABLE/FORCE — so these policies are only active for
    # non-superuser connections (e.g. future read-only reporting roles).
    # The enforceable guarantee is the service layer, which filters every
    # conversation/message query by participant membership.
    op.execute(_RLS_FUNC_SQL)
    op.execute("ALTER TABLE conversations ENABLE ROW LEVEL SECURITY")
    op.execute(
        """
        CREATE POLICY conversations_user_isolation ON conversations
            USING (
                user_a = current_setting('app.current_user_id', true)
                OR user_b = current_setting('app.current_user_id', true)
            );
        """
    )
    op.execute("ALTER TABLE messages ENABLE ROW LEVEL SECURITY")
    op.execute(
        """
        CREATE POLICY messages_user_isolation ON messages
            USING (app_is_conversation_participant(conversation_id));
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS messages")
    op.execute("DROP TABLE IF EXISTS conversations")
    op.execute("DROP FUNCTION IF EXISTS app_is_conversation_participant(uuid)")