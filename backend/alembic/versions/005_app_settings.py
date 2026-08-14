"""Add app_settings table for admin-managed runtime configuration.

Key/value store (JSON-encoded values). Currently used for the trusted-hosts
whitelist (TrustedHost list) that the admin API manages so LAN access works
without hardcoding IPs — persisted here so it survives restarts and works on
any network the machine joins.

Revision ID: 005
Revises: 004
Create Date: 2026-08-14
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "005"
down_revision: Union[str, None] = "004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "app_settings",
        sa.Column("key", sa.Text(), primary_key=True),
        sa.Column("value", sa.Text(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )


def downgrade() -> None:
    op.drop_table("app_settings")