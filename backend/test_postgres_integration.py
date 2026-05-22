"""
Integration test — create → read → update → delete receipt with items.

Requires a running PostgreSQL at DATABASE_URL.  Run after alembic upgrade head.

    python test_postgres_integration.py
"""
import asyncio
import os
import sys
import uuid
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Import application modules
from app.core.database import init_pool, close_pool
from app.services.database_service import (
    DatabaseService, sanitize_numeric,
    _parse_date_mmddyyyy, _format_date_mmddyyyy,
    _receipt_row_to_dict,
    save_image, save_thumbnail, delete_receipt_images, read_image,
)
from app.services.audit_service import AuditService
from app.schemas.receipt import AuditAction

TEST_USER = f"test-user-{uuid.uuid4().hex[:8]}"


async def main():
    print("=== PostgreSQL Integration Test ===\n")

    # 1. Connect
    print("1. Initializing connection pool...")
    await init_pool()
    print("   ✓ Connected")

    # 2. Create receipt with items
    print("\n2. Creating receipt with line items...")
    data = {
        "status": "needs_review",
        "supplier": "TestMart Ltd",
        "totalAmount": "1,740.00",
        "taxAmount": "240.00",
        "receiptDate": "05/22/2026",
        "category": "Groceries",
        "invoiceNumber": "INV-2026-001",
        "kraPin": "A123456789Z",
        "cuInvoice": "CU-98765",
        "batchTitle": "May Records",
        "items": [
            {"name": "Milk", "quantity": 2, "price": "150.00", "tax": "24.00", "isZeroRated": False, "discount": None},
            {"name": "Bread", "quantity": 1, "price": "500.00", "tax": "80.00", "isZeroRated": False, "discount": "10"},
            {"name": "Fresh Veg", "quantity": 3, "price": "200.00", "tax": "0", "isZeroRated": True, "discount": None},
        ],
    }

    receipt_id = await DatabaseService.create_receipt(TEST_USER, data)
    print(f"   ✓ Created receipt {receipt_id}")

    # 3. Read receipt
    print("\n3. Reading receipt with items...")
    receipt = await DatabaseService.get_receipt(TEST_USER, receipt_id)
    assert receipt is not None, "Receipt not found"
    assert receipt["supplier"] == "TestMart Ltd"
    assert receipt["totalAmount"] == "1740.00"
    assert receipt["taxAmount"] == "240.00"
    assert receipt["receiptDate"] == "05/22/2026"
    assert receipt["category"] == "Groceries"
    assert receipt["invoiceNumber"] == "INV-2026-001"
    assert receipt["kraPin"] == "A123456789Z"
    assert receipt["cuInvoice"] == "CU-98765"
    assert receipt["batchTitle"] == "May Records"
    assert len(receipt["items"]) == 3
    assert receipt["items"][0]["name"] == "Milk"
    assert receipt["items"][0]["quantity"] == 2.0
    assert receipt["items"][0]["price"] == "150.00"
    assert receipt["items"][0]["tax"] == "24.00"
    assert receipt["items"][0]["isZeroRated"] is False
    assert receipt["items"][1]["discount"] == "10.00"  # NUMERIC → string with 2dp
    assert receipt["items"][2]["isZeroRated"] is True
    assert receipt["items"][2]["tax"] == "0.00"
    print("   ✓ All receipt fields correct")

    # 4. List receipts
    print("\n4. Listing receipts...")
    recs, total = await DatabaseService.list_receipts(TEST_USER, skip=0, limit=10)
    assert total == 1
    assert len(recs) == 1
    assert recs[0]["id"] == receipt_id
    print(f"   ✓ Listed {total} receipt(s)")

    # 5. List with status filter
    print("\n5. Listing with status filter...")
    recs, total = await DatabaseService.list_receipts(TEST_USER, status="needs_review")
    assert total == 1
    recs, total = await DatabaseService.list_receipts(TEST_USER, status="processed")
    assert total == 0
    print("   ✓ Status filter works")

    # 6. List with batch title filter
    print("\n6. Listing with batch title filter...")
    recs, total = await DatabaseService.list_receipts(TEST_USER, batch_title="May Records")
    assert total == 1
    recs, total = await DatabaseService.list_receipts(TEST_USER, batch_title="__ungrouped__")
    assert total == 0
    print("   ✓ Batch title filter works")

    # 7. Update receipt
    print("\n7. Updating receipt...")
    await DatabaseService.update_receipt(
        TEST_USER, receipt_id,
        {
            "supplier": "TestMart Superstore",
            "totalAmount": "1800.00",
            "status": "processed",
            "items": [
                {"name": "Milk Updated", "quantity": 3, "price": "160.00", "tax": "25.60", "isZeroRated": False, "discount": None},
            ],
        },
    )
    updated = await DatabaseService.get_receipt(TEST_USER, receipt_id)
    assert updated["supplier"] == "TestMart Superstore"
    assert updated["totalAmount"] == "1800.00"
    assert updated["status"] == "processed"
    assert len(updated["items"]) == 1
    assert updated["items"][0]["name"] == "Milk Updated"
    assert updated["items"][0]["quantity"] == 3.0
    print("   ✓ Receipt updated")

    # 8. Search receipts
    print("\n8. Searching receipts...")
    results = await DatabaseService.search_receipts(
        TEST_USER, supplier="TestMart Superstore",
    )
    assert len(results) == 1

    results = await DatabaseService.search_receipts(
        TEST_USER, category="Groceries",
    )
    assert len(results) == 1

    results = await DatabaseService.search_receipts(
        TEST_USER, date_from="01/01/2026", date_to="12/31/2026",
    )
    assert len(results) == 1

    results = await DatabaseService.search_receipts(
        TEST_USER, date_from="01/01/2025", date_to="01/01/2025",
    )
    assert len(results) == 0
    print("   ✓ Search works")

    # 9. Duplicate check
    print("\n9. Checking duplicates...")
    dups = await DatabaseService.check_duplicate(
        TEST_USER,
        invoiceNumber="INV-2026-001",
    )
    assert len(dups) == 1
    assert dups[0]["_confidence"] == "high"

    dups = await DatabaseService.check_duplicate(
        TEST_USER,
        supplier="TestMart Superstore",
        totalAmount="1800.00",
    )
    assert len(dups) >= 1
    print("   ✓ Duplicate check works")

    # 10. Get receipt groups
    print("\n10. Getting receipt groups...")
    # First give this receipt an image
    img_data = b"\xff\xd8\xff\xe0" + b"\x00" * 1024  # minimal JPEG bytes
    save_image(receipt_id, img_data)
    save_thumbnail(receipt_id, img_data)
    await DatabaseService.update_receipt(TEST_USER, receipt_id, {
        "image_filename": f"{receipt_id}.jpg",
    })

    groups = await DatabaseService.get_receipt_groups(TEST_USER)
    assert len(groups) >= 1
    assert groups[0]["batchTitle"] == "May Records"
    assert groups[0]["count"] == 1
    print("   ✓ Receipt groups work")

    # 11. Read image from disk
    print("\n11. Reading image from local filesystem...")
    img = read_image(receipt_id)
    assert img is not None
    assert len(img) > 0
    thumb = read_image(receipt_id, thumb=True)
    assert thumb is not None
    print(f"   ✓ Image ({len(img)} bytes) and thumbnail ({len(thumb)} bytes) read")

    # 12. Audit log
    print("\n12. Creating audit entry...")
    entry_id = await AuditService.log(
        TEST_USER, receipt_id, AuditAction.UPDATED, TEST_USER,
    )
    trail = await AuditService.get_audit_trail(TEST_USER, receipt_id)
    assert len(trail) >= 1
    assert trail[0]["action"] == "updated"
    print(f"   ✓ Audit trail has {len(trail)} entries")

    # 13. Delete receipt
    print("\n13. Deleting receipt...")
    delete_receipt_images(receipt_id)
    deleted = await DatabaseService.delete_receipt(TEST_USER, receipt_id)
    assert deleted is True
    # Verify deletion
    gone = await DatabaseService.get_receipt(TEST_USER, receipt_id)
    assert gone is None
    print("   ✓ Receipt deleted")

    # 14. Image cleanup verified
    print("\n14. Verifying image cleanup...")
    assert read_image(receipt_id) is None
    print("   ✓ Images cleaned up")

    # 15. Settings CRUD
    print("\n15. Testing user settings...")
    saved = await DatabaseService.update_user_settings(TEST_USER, "ai_config", {
        "provider": "gemini",
        "model_id": "gemini-pro",
        "configs": {"gemini": {"api_key": "test-key", "enabled": True}},
    })
    assert saved is True

    settings = await DatabaseService.get_user_settings(TEST_USER, "ai_config")
    assert settings["provider"] == "gemini"
    assert settings["model_id"] == "gemini-pro"
    print("   ✓ User settings work")

    # Cleanup settings
    from app.core.database import get_pool
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM user_ai_settings WHERE user_id = $1", TEST_USER)

    print("\n" + "=" * 50)
    print("✓ ALL INTEGRATION TESTS PASSED")
    print("=" * 50)

    await close_pool()


if __name__ == "__main__":
    asyncio.run(main())
