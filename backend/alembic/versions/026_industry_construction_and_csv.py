"""Rename General to Construction and allow deletion; modern industry UI prep.

- Rename General industry to Construction (for current dev working with construction)
- Make it non-system so it can be deactivated/deleted like other industries
- Categories remain under Construction (42)
- No data loss: receipts keep category TEXT snapshot, FKs remain
"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa

revision: str = "026"
down_revision: Union[str, None] = "025"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

def upgrade() -> None:
    conn = op.get_bind()
    # Rename General to Construction if exists, else ensure Construction exists
    general = conn.execute(sa.text("SELECT id FROM industries WHERE lower(name)=lower('General')")).fetchone()
    construction = conn.execute(sa.text("SELECT id FROM industries WHERE lower(name)=lower('Construction')")).fetchone()
    if general and not construction:
        conn.execute(sa.text("UPDATE industries SET name='Construction', description='Construction industry', is_system=false, updated_at=now() WHERE lower(name)=lower('General')"))
    elif not general and not construction:
        # fresh install after 025 but before this migration (edge): seed Construction directly via 025 General path then rename, but if neither exists (should not), create Construction and categories
        conn.execute(sa.text("INSERT INTO industries (name, description, is_system, is_active) VALUES ('Construction', 'Construction industry', false, true) ON CONFLICT (name) DO NOTHING"))
        cid = conn.execute(sa.text("SELECT id FROM industries WHERE lower(name)=lower('Construction')")).scalar()
        if cid:
            cats = ["Building Materials", "Hardware & Tools", "Paint & Finishes", "Plumbing & Sanitary", "Electrical Supplies", "Security & Surveillance", "Fuel & Lubricants", "Vehicle Maintenance", "Transport Services", "Utilities & Bills", "Seeds & Inputs", "Fertilizers & Chemicals", "Farm Tools & Equipment", "Greenhouse Supplies", "Crop Harvesting & Processing", "Agro Consultancy & Training", "Animal Feed & Supplements", "Livestock & Poultry", "Veterinary Services", "Food & Groceries", "Furniture & Fixtures", "Utensils & Cutlery", "Cleaning Supplies", "Baby & Kids Supplies", "Clothing & Footwear", "Personal Care & Beauty", "Health & Medicine", "Stationery & Office Supplies", "Professional & Business Services", "Employee Salaries & Wages", "Licenses & Permits", "Rent, Lease & Property", "Electronics & Appliances", "Phones & Accessories", "Computers & IT Equipment", "Raw Materials", "Packaging Supplies", "Gifts & Donations", "Entertainment & Leisure", "Repairs & Maintenance", "Emergency Purchases", "Other"]
            for idx, cat in enumerate(cats):
                conn.execute(sa.text("INSERT INTO categories (industry_id, name, label, is_system, is_active, sort_order) VALUES (:iid, :name, :label, true, true, :ord) ON CONFLICT DO NOTHING"), {"iid": str(cid), "name": cat, "label": cat, "ord": idx})
    else:
        # both exist - keep Construction, optionally deactivate General if empty
        pass
    # Ensure Construction is not system (so it can be removed as whole if user wants)
    conn.execute(sa.text("UPDATE industries SET is_system=false WHERE lower(name)=lower('Construction')"))

def downgrade() -> None:
    conn = op.get_bind()
    conn.execute(sa.text("UPDATE industries SET name='General', description='Default industry seeded from existing taxonomy', is_system=true WHERE lower(name)=lower('Construction')"))
