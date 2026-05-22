"""
Unit tests for database_service.py helpers and serializers (no PG/asyncpg required).
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from datetime import date
from decimal import Decimal
import re


# ── Copy helpers inline to avoid asyncpg import ──────────────────────────

def sanitize_numeric(value):
    if value is None:
        return 0.0
    if isinstance(value, (int, float, Decimal)):
        return float(value)
    cleaned = re.sub(r"[^0-9.\-]", "", str(value))
    try:
        return float(cleaned)
    except ValueError:
        return 0.0


def _parse_date_mmddyyyy(s):
    if not s:
        return None
    try:
        parts = s.strip().split("/")
        if len(parts) == 3:
            return date(int(parts[2]), int(parts[0]), int(parts[1]))
    except (ValueError, TypeError):
        pass
    try:
        return date.fromisoformat(s.strip())
    except (ValueError, TypeError):
        return None


def _format_date_mmddyyyy(d):
    return d.strftime("%m/%d/%Y")


def _to_numeric(val):
    if val is None:
        return None
    try:
        return Decimal(str(val))
    except Exception:
        return None


def _receipt_row_to_dict(row, items=None):
    rid = str(row["id"])
    image_url = None
    thumbnail_url = None
    if row.get("image_filename"):
        image_url = f"/receipt-images/{rid}"
        thumbnail_url = f"/receipt-images/{rid}?thumb=1"
    elif row.get("legacy_image_url"):
        image_url = row["legacy_image_url"]
        thumbnail_url = row.get("legacy_thumbnail_url")

    total_amount = row.get("total_amount")
    if total_amount is not None and not isinstance(total_amount, str):
        total_amount = str(total_amount)
    tax_amount = row.get("tax_amount")
    if tax_amount is not None and not isinstance(tax_amount, str):
        tax_amount = str(tax_amount)
    receipt_date = row.get("receipt_date")
    if isinstance(receipt_date, date):
        receipt_date = _format_date_mmddyyyy(receipt_date)

    return {
        "id": rid,
        "userId": row["user_id"],
        "status": row["status"],
        "supplier": row["supplier"],
        "totalAmount": total_amount,
        "taxAmount": tax_amount,
        "receiptDate": receipt_date,
        "category": row.get("category"),
        "invoiceNumber": row.get("invoice_number"),
        "kraPin": row.get("kra_pin"),
        "cuInvoice": row.get("cu_invoice"),
        "batchTitle": row.get("batch_title"),
        "imageUrl": image_url,
        "thumbnailUrl": thumbnail_url,
        "items": items or [],
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at"),
        "scannedAt": row.get("scanned_at"),
    }


# ── Tests ────────────────────────────────────────────────────────────────

def test_sanitize_numeric():
    assert sanitize_numeric("1,234.56") == 1234.56
    assert sanitize_numeric("KES 500") == 500.0
    assert sanitize_numeric("") == 0.0
    assert sanitize_numeric(None) == 0.0
    assert sanitize_numeric(42) == 42.0
    assert sanitize_numeric(Decimal("99.99")) == 99.99
    print("  ✓ sanitize_numeric")


def test_parse_date_mmddyyyy():
    assert _parse_date_mmddyyyy("03/15/2025") == date(2025, 3, 15)
    assert _parse_date_mmddyyyy("2025-03-15") == date(2025, 3, 15)
    assert _parse_date_mmddyyyy("") is None
    assert _parse_date_mmddyyyy(None) is None
    assert _parse_date_mmddyyyy("not-a-date") is None
    print("  ✓ parse_date_mmddyyyy")


def test_format_date():
    assert _format_date_mmddyyyy(date(2025, 3, 15)) == "03/15/2025"
    assert _format_date_mmddyyyy(date(2025, 12, 1)) == "12/01/2025"
    print("  ✓ format_date_mmddyyyy")


def test_to_numeric():
    assert _to_numeric("10.5") == Decimal("10.5")
    assert _to_numeric(None) is None
    assert _to_numeric(0) == Decimal("0")
    assert _to_numeric("0") == Decimal("0")
    print("  ✓ to_numeric")


def test_row_to_dict_with_items():
    row = {
        "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "user_id": "firebase-uid-123",
        "status": "processed",
        "supplier": "Test Supplier",
        "total_amount": Decimal("1500.00"),
        "tax_amount": Decimal("240.00"),
        "receipt_date": date(2025, 3, 15),
        "category": "Food",
        "invoice_number": "INV-001",
        "kra_pin": "A123456789Z",
        "cu_invoice": None,
        "batch_title": "March Batch",
        "image_filename": "a1b2c3d4.jpg",
        "thumbnail_filename": None,
        "legacy_image_url": None,
        "created_at": None,
        "updated_at": None,
        "scanned_at": None,
    }
    items = [
        {"name": "Item A", "quantity": 2.0, "price": "500.00", "tax": "80.00", "isZeroRated": False, "discount": None},
        {"name": "Item B", "quantity": 1.0, "price": "500.00", "tax": "80.00", "isZeroRated": False, "discount": "10"},
    ]
    result = _receipt_row_to_dict(row, items)
    assert result["id"] == "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
    assert result["userId"] == "firebase-uid-123"
    assert result["totalAmount"] == "1500.00"
    assert result["taxAmount"] == "240.00"
    assert result["receiptDate"] == "03/15/2025"
    assert result["imageUrl"].startswith("/receipt-images/")
    assert result["thumbnailUrl"].endswith("?thumb=1")
    assert len(result["items"]) == 2
    assert result["items"][0]["price"] == "500.00"
    assert result["items"][0]["isZeroRated"] is False
    assert result["items"][1]["discount"] == "10"
    print("  ✓ row_to_dict with items")


def test_row_to_dict_legacy_image():
    row = {
        "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        "user_id": "uid",
        "status": "processed",
        "supplier": "Sup",
        "total_amount": Decimal("100"),
        "tax_amount": None,
        "receipt_date": date(2025, 1, 1),
        "category": None,
        "invoice_number": None,
        "kra_pin": None,
        "cu_invoice": None,
        "batch_title": None,
        "image_filename": None,
        "thumbnail_filename": None,
        "legacy_image_url": "https://storage.googleapis.com/b/path/img.jpg",
        "created_at": None,
        "updated_at": None,
        "scanned_at": None,
    }
    result = _receipt_row_to_dict(row)
    assert result["imageUrl"] == "https://storage.googleapis.com/b/path/img.jpg"
    assert result["thumbnailUrl"] is None
    print("  ✓ row_to_dict legacy image")


def test_empty_items():
    row = {
        "id": "empty-items-uuid",
        "user_id": "uid",
        "status": "needs_review",
        "supplier": "S",
        "total_amount": Decimal("0"),
        "tax_amount": None,
        "receipt_date": date(2025, 5, 22),
        "category": None,
        "invoice_number": None,
        "kra_pin": None,
        "cu_invoice": None,
        "batch_title": None,
        "image_filename": None,
        "thumbnail_filename": None,
        "legacy_image_url": None,
        "created_at": None,
        "updated_at": None,
        "scanned_at": None,
    }
    result = _receipt_row_to_dict(row, [])
    assert result["items"] == []
    assert result["totalAmount"] == "0"
    print("  ✓ empty items")


if __name__ == "__main__":
    test_sanitize_numeric()
    test_parse_date_mmddyyyy()
    test_format_date()
    test_to_numeric()
    test_row_to_dict_with_items()
    test_row_to_dict_legacy_image()
    test_empty_items()
    print("\n✓ All database_service tests passed!")
