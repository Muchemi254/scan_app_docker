"""Add indexes used by receipt full-text and partial search.

Revision ID: 018
Revises: 017
"""
from typing import Sequence, Union

from alembic import op


revision: str = "018"
down_revision: Union[str, None] = "017"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


RECEIPT_SEARCH_TEXT = """COALESCE(supplier, '') || ' ' || COALESCE(category, '') || ' ' ||
    COALESCE(invoice_number, '') || ' ' || COALESCE(kra_pin, '') || ' ' ||
    COALESCE(buyer_kra_pin, '') || ' ' || COALESCE(cu_invoice, '') || ' ' ||
    COALESCE(batch_title, '') || ' ' || COALESCE(location, '')"""
ITEM_SEARCH_TEXT = """COALESCE(name, '')"""


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.execute(
        f"""CREATE INDEX IF NOT EXISTS idx_receipts_search_fts
        ON receipts USING gin (to_tsvector('simple', {RECEIPT_SEARCH_TEXT}))"""
    )
    op.execute(
        f"""CREATE INDEX IF NOT EXISTS idx_receipts_search_trgm
        ON receipts USING gin (({RECEIPT_SEARCH_TEXT}) gin_trgm_ops)"""
    )
    op.execute(
        f"""CREATE INDEX IF NOT EXISTS idx_line_items_search_fts
        ON line_items USING gin (to_tsvector('simple', {ITEM_SEARCH_TEXT}))"""
    )
    op.execute(
        f"""CREATE INDEX IF NOT EXISTS idx_line_items_search_trgm
        ON line_items USING gin (({ITEM_SEARCH_TEXT}) gin_trgm_ops)"""
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_line_items_search_trgm")
    op.execute("DROP INDEX IF EXISTS idx_line_items_search_fts")
    op.execute("DROP INDEX IF EXISTS idx_receipts_search_trgm")
    op.execute("DROP INDEX IF EXISTS idx_receipts_search_fts")
