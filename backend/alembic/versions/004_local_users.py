"""Add local users table for offline (AUTH_MODE=local) authentication.

Stores email + bcrypt password hash so signup/login work with zero
internet (no Firebase). The uid column is the same string identity used
everywhere else (receipts.user_id etc.) and feeds Row-Level Security.

This table is deliberately NOT RLS-enforced — the auth layer must be able
to read credentials for any user during login.

Revision ID: 004
Revises: 003
Create Date: 2026-08-14
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "004"
down_revision: Union[str, None] = "003"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("uid", sa.Text(), primary_key=True),
        sa.Column("email", sa.Text(), nullable=False),
        sa.Column("password_hash", sa.Text(), nullable=False),
        sa.Column("is_admin", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("display_name", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint("uid", name="uq_users_uid"),
    )
    # Case-insensitive unique email (avoid needing the citext extension)
    op.create_index(
        "uq_users_email_lower",
        "users",
        [sa.text("lower(email)")],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("uq_users_email_lower", table_name="users")
    op.drop_table("users")
