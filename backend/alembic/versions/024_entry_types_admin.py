"""Admin-managed entry types.

Entry types are global reference data like locations. The default 'expense'
counts toward totals; others are retained but excluded. Admins can add custom
types via the admin UI.

Revision ID: 024
Revises: 023
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "024"
down_revision: Union[str, None] = "023"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "entry_types",
        sa.Column("id", sa.Text(), primary_key=True, server_default=sa.text("gen_random_uuid()::text")),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("TRUE")),
        sa.Column("is_system", sa.Boolean(), nullable=False, server_default=sa.text("FALSE")),
        sa.Column("created_by", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("idx_entry_types_name", "entry_types", ["name"], unique=True)
    op.create_index("idx_entry_types_active", "entry_types", ["is_active"])
    # Seed system defaults
    op.execute("""
        INSERT INTO entry_types (name, label, is_system, is_active, created_by)
        VALUES
            ('expense', 'Expense', true, true, 'system'),
            ('quotation', 'Quotation', true, true, 'system'),
            ('proforma', 'Proforma', true, true, 'system'),
            ('deposit', 'Deposit', true, true, 'system'),
            ('note', 'Note', true, true, 'system')
        ON CONFLICT (name) DO NOTHING
    """)


def downgrade() -> None:
    op.drop_index("idx_entry_types_active", table_name="entry_types")
    op.drop_index("idx_entry_types_name", table_name="entry_types")
    op.drop_table("entry_types")
