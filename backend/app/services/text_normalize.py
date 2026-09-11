"""Shared uppercase normalization for supplier names and categories.

Supplier names and receipt categories are always stored UPPERCASE so the
same supplier can never appear as two rows ("Acme" vs "ACME") and category
breakdowns never split on case.

Rules (deliberately simple, locale-independent):
  - collapse all whitespace runs to a single space, strip ends
  - ``str.upper()`` the result
  - empty / None → fallback ("UNKNOWN" for supplier, "OTHER" for category)

Category *mapping* (alias → canonical) still lives in
``app.services.gemini.normalize_category`` — this module only uppercases
already-mapped values so ``database_service`` and Pydantic validators can
normalize without importing the heavy Gemini module (which would be a
circular import: gemini → data_adapter → database_service).
"""

from typing import Optional


def _collapse(value: str) -> str:
    return " ".join(value.split())


def normalize_supplier_name(raw: Optional[object], fallback: str = "UNKNOWN") -> str:
    """Collapse whitespace and uppercase a supplier name."""
    if raw is None:
        return fallback
    collapsed = _collapse(str(raw))
    if not collapsed:
        return fallback
    upper = collapsed.upper()
    return upper or fallback


def normalize_category_text(raw: Optional[object], fallback: str = "OTHER") -> str:
    """Collapse whitespace and uppercase a category snapshot."""
    if raw is None:
        return fallback
    collapsed = _collapse(str(raw))
    if not collapsed:
        return fallback
    # Treat common empties as missing.
    if collapsed.upper() in ("N/A", "NA", "NONE", "NULL", "-"):
        return fallback
    return collapsed.upper()
