"""Category taxonomy guards (docs/category-taxonomy.md).

Keeps the canonical 42-category list sane: no duplicates, every alias
resolves, and normalize_category() never returns an invented category.
"""
import pytest

from app.services.gemini import (
    CATEGORIES,
    CATEGORY_ALIASES,
    normalize_category,
)


def test_categories_are_unique():
    assert len(CATEGORIES) == len(set(CATEGORIES)), "duplicate categories in list"


def test_other_is_a_real_category():
    assert "Other" in CATEGORIES


def test_canonical_passthrough():
    for cat in CATEGORIES:
        assert normalize_category(cat) == cat
        # Whitespace noise around a canonical name still resolves.
        assert normalize_category(f"  {cat}  ") == cat


def test_aliases_resolve_to_canonical():
    for old, canonical in CATEGORY_ALIASES.items():
        assert canonical in CATEGORIES, f"alias target {canonical!r} not in list"
        assert normalize_category(old) == canonical
        # Case-insensitive and whitespace-insensitive matching.
        assert normalize_category(old.lower()) == canonical
        assert normalize_category(f" {old} ") == canonical


def test_merged_db_values_covered():
    # Every legacy value that existed in the database maps to a canonical
    # category (the set from the 019 backfill migration, minus BANK DEPOSIT
    # which belongs to the entry-type feature).
    legacy = {
        "Groceries & Provisions", "Perishables", "Beverages", "Restaurant & Catering",
        "Irrigation Supplies", "Veterinary Inputs & Services",
        "Repairs & Maintenance Services", "Facility maintenance services",
        "Energy & Utilities", "Internet & Airtime", "Marketing & Branding",
        "Professional Services", "Subscriptions & Memberships", "Education & Learning",
        "Rent & Lease", "Land & Property Purchases",
        " Animal Feed & Supplements", "building materials", "cleaning",
    }
    for value in legacy:
        assert normalize_category(value) != "Other", f"{value!r} fell through to Other"


def test_unknown_values_fall_back_to_other():
    assert normalize_category("") == "Other"
    assert normalize_category(None) == "Other"
    assert normalize_category("N/A") == "Other"
    assert normalize_category("Some Made Up Category") == "Other"
    assert normalize_category("ELECTRONICS") == "Other"  # no case-folding of canonical


def test_extraction_never_stores_invented_categories():
    """Regression: extraction previously stored raw model output (e.g. 'N/A')."""
    from app.schemas.receipt import ReceiptCreate

    r = ReceiptCreate(
        supplier="Test",
        totalAmount="10.00",
        category="N/A",
        receiptDate="01/01/2025",
        status="needs_review",
    )
    # The schema keeps the raw value; normalization happens in gemini.py's
    # extract functions — assert the function contract here.
    assert normalize_category(r.category) == "Other"
