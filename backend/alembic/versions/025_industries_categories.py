"""Admin-managed industries + categories (global, like locations).

- industries: global reference, admin manages (Hospitality, Construction, etc.)
- categories: per-industry, optionally hierarchical via parent_id
- receipts: add nullable industry_id/category_id FKs, keep category TEXT snapshot for history
- user_preferences: default_industry_id per user
- Auto-seed General industry + 42 canonical categories (is_system) and backfill existing receipts
  so dev DB with data is not blocked by onboarding.

Revision ID: 025
Revises: 024
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "025"
down_revision: Union[str, None] = "024"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

# same 42 canonical categories as gemini.py
_CATEGORIES = [
    "Building Materials", "Hardware & Tools", "Paint & Finishes",
    "Plumbing & Sanitary", "Electrical Supplies", "Security & Surveillance",
    "Fuel & Lubricants", "Vehicle Maintenance", "Transport Services",
    "Utilities & Bills",
    "Seeds & Inputs", "Fertilizers & Chemicals", "Farm Tools & Equipment",
    "Greenhouse Supplies", "Crop Harvesting & Processing",
    "Agro Consultancy & Training",
    "Animal Feed & Supplements", "Livestock & Poultry", "Veterinary Services",
    "Food & Groceries", "Furniture & Fixtures", "Utensils & Cutlery",
    "Cleaning Supplies", "Baby & Kids Supplies",
    "Clothing & Footwear", "Personal Care & Beauty", "Health & Medicine",
    "Stationery & Office Supplies", "Professional & Business Services",
    "Employee Salaries & Wages", "Licenses & Permits", "Rent, Lease & Property",
    "Electronics & Appliances", "Phones & Accessories", "Computers & IT Equipment",
    "Raw Materials", "Packaging Supplies", "Gifts & Donations",
    "Entertainment & Leisure",
    "Repairs & Maintenance", "Emergency Purchases", "Other"
]


def upgrade() -> None:
    # industries
    op.create_table(
        "industries",
        sa.Column("id", sa.Text(), primary_key=True, server_default=sa.text("gen_random_uuid()::text")),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("TRUE")),
        sa.Column("is_system", sa.Boolean(), nullable=False, server_default=sa.text("FALSE")),
        sa.Column("created_by", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("idx_industries_name", "industries", ["name"], unique=True)
    op.create_index("idx_industries_active", "industries", ["is_active"])

    # categories
    op.create_table(
        "categories",
        sa.Column("id", sa.Text(), primary_key=True, server_default=sa.text("gen_random_uuid()::text")),
        sa.Column("industry_id", sa.Text(), sa.ForeignKey("industries.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column("parent_id", sa.Text(), sa.ForeignKey("categories.id", ondelete="SET NULL"), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("TRUE")),
        sa.Column("is_system", sa.Boolean(), nullable=False, server_default=sa.text("FALSE")),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("created_by", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("idx_categories_industry", "categories", ["industry_id"])
    op.create_index("idx_categories_parent", "categories", ["parent_id"])
    op.create_index("idx_categories_active", "categories", ["is_active"])
    op.create_unique_constraint("uq_categories_industry_name", "categories", ["industry_id", "name"])
    # unique lower(name) per industry via functional index
    op.create_index("uq_categories_industry_lower_name", "categories", [sa.text("industry_id"), sa.text("lower(name)")], unique=True)

    # receipts nullable FKs + scan_sessions industry + user_preferences default
    op.add_column("receipts", sa.Column("industry_id", sa.Text(), sa.ForeignKey("industries.id", ondelete="RESTRICT"), nullable=True))
    op.add_column("receipts", sa.Column("category_id", sa.Text(), sa.ForeignKey("categories.id", ondelete="RESTRICT"), nullable=True))
    op.create_index("idx_receipts_industry_id", "receipts", ["industry_id"])
    op.create_index("idx_receipts_category_id", "receipts", ["category_id"])
    op.add_column("scan_sessions", sa.Column("industry_id", sa.Text(), sa.ForeignKey("industries.id", ondelete="SET NULL"), nullable=True))
    op.create_index("idx_scan_sessions_industry_id", "scan_sessions", ["industry_id"])
    op.add_column("user_preferences", sa.Column("default_industry_id", sa.Text(), sa.ForeignKey("industries.id", ondelete="SET NULL"), nullable=True))

    # seed General industry + 42 categories
    op.execute(sa.text("INSERT INTO industries (name, description, is_system, is_active) VALUES ('General', 'Default industry seeded from existing taxonomy', true, true) ON CONFLICT (name) DO NOTHING"))
    # need General id for categories
    conn = op.get_bind()
    general_id = conn.execute(sa.text("SELECT id FROM industries WHERE lower(name)=lower('General')")).scalar()
    if general_id:
        for idx, cat in enumerate(_CATEGORIES):
            conn.execute(sa.text("INSERT INTO categories (industry_id, name, label, is_system, is_active, sort_order) VALUES (:iid, :name, :label, true, true, :ord) ON CONFLICT DO NOTHING"), {"iid": str(general_id), "name": cat, "label": cat, "ord": idx})

    # backfill existing receipts: map category TEXT -> category_id under General
    # only where category is not null/empty and matches a seeded category case-insensitive
    conn.execute(sa.text("""
        UPDATE receipts r
        SET category_id = c.id,
            industry_id = c.industry_id
        FROM categories c
        WHERE c.industry_id = :gid
          AND lower(c.name) = lower(btrim(r.category))
          AND r.category IS NOT NULL AND btrim(r.category) <> '' AND lower(btrim(r.category)) <> 'n/a'
          AND r.category_id IS NULL
    """), {"gid": str(general_id) if general_id else None})

    # user_preferences default to General for existing users (non-blocking)
    if general_id:
        conn.execute(sa.text("UPDATE user_preferences SET default_industry_id = :gid WHERE default_industry_id IS NULL"), {"gid": str(general_id)})


def downgrade() -> None:
    op.drop_column("user_preferences", "default_industry_id")
    op.drop_index("idx_scan_sessions_industry_id", table_name="scan_sessions")
    op.drop_column("scan_sessions", "industry_id")
    op.drop_index("idx_receipts_category_id", table_name="receipts")
    op.drop_index("idx_receipts_industry_id", table_name="receipts")
    op.drop_column("receipts", "category_id")
    op.drop_column("receipts", "industry_id")
    op.drop_index("uq_categories_industry_lower_name", table_name="categories")
    op.drop_constraint("uq_categories_industry_name", "categories", type_="unique")
    op.drop_index("idx_categories_active", table_name="categories")
    op.drop_index("idx_categories_parent", table_name="categories")
    op.drop_index("idx_categories_industry", table_name="categories")
    op.drop_table("categories")
    op.drop_index("idx_industries_active", table_name="industries")
    op.drop_index("idx_industries_name", table_name="industries")
    op.drop_table("industries")
