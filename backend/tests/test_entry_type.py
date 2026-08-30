"""Entry-type (non-expense flag) coverage.

Non-expense entries (quotation/proforma/deposit/note) are retained, visible in
lists, but excluded from totals, groups and exports by default.
"""
import pytest

from tests.helpers import ADMIN_EMAIL, ADMIN_PASSWORD, create_user_via_admin, login


async def _new_user(client, suffix: str):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    user = await create_user_via_admin(
        client, admin_headers, f"entry_{suffix}@pytest.local", "testpass123"
    )
    headers, _, _ = await login(client, f"entry_{suffix}@pytest.local", "testpass123")
    return user, headers


async def _insert_receipt(pool, user_id: str, supplier: str, amount: float, entry_type: str = "expense"):
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO receipts (
                id, user_id, status, entry_type, supplier, total_amount, receipt_date, category
            ) VALUES (
                gen_random_uuid()::text, $1, 'processed', $2, $3, $4, CURRENT_DATE, $5
            ) RETURNING id
            """,
            user_id, entry_type, supplier, amount, "Other",
        )
        return str(row["id"])


@pytest.mark.asyncio
async def test_create_and_update_entry_type_via_api(client):
    from app.core.database import get_pool

    user, headers = await _new_user(client, "crud")
    uid = user["uid"]

    # Create with a non-expense entry type through the API contract.
    create = await client.post(
        f"/api/v1/users/{uid}/receipts",
        data={
            "receipt_data": (
                '{"supplier": "Quote Co", "totalAmount": "1500.00", "receiptDate": "01/10/2025",'
                ' "category": "Building Materials", "status": "needs_review", "entryType": "quotation"}'
            ),
        },
        headers=headers,
    )
    assert create.status_code == 201, create.text
    rid = create.json()["id"]
    assert create.json()["entryType"] == "quotation"

    # Toggle back to expense via update.
    update = await client.put(
        f"/api/v1/users/{uid}/receipts/{rid}",
        data={"receipt_data": '{"entryType": "expense"}'},
        headers=headers,
    )
    assert update.status_code == 200, update.text
    assert update.json()["entryType"] == "expense"


@pytest.mark.asyncio
async def test_list_entry_type_filter(client):
    from app.core.database import get_pool

    user, headers = await _new_user(client, "list")
    uid = user["uid"]
    pool = await get_pool()

    await _insert_receipt(pool, uid, "Expense Shop", 100, "expense")
    await _insert_receipt(pool, uid, "Quote Shop", 200, "quotation")
    await _insert_receipt(pool, uid, "Deposit Shop", 300, "deposit")

    async def list_q(**params):
        r = await client.get(
            f"/api/v1/users/{uid}/receipts", params=params, headers=headers
        )
        assert r.status_code == 200, r.text
        return r.json()["items"]

    # All entries are visible by default (retained, not deleted).
    all_items = await list_q()
    assert {i["supplier"] for i in all_items} == {"Expense Shop", "Quote Shop", "Deposit Shop"}

    assert {i["supplier"] for i in await list_q(entryType="expense")} == {"Expense Shop"}
    assert {i["supplier"] for i in await list_q(entryType="quotation")} == {"Quote Shop"}
    non_expense = await list_q(entryType="non_expense")
    assert {i["supplier"] for i in non_expense} == {"Quote Shop", "Deposit Shop"}


@pytest.mark.asyncio
async def test_groups_and_dashboard_exclude_non_expense(client):
    from app.core.database import get_pool

    user, headers = await _new_user(client, "totals")
    uid = user["uid"]
    pool = await get_pool()

    # Give both receipts an image so they land in groups; amounts are distinct.
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO receipts (
                id, user_id, status, entry_type, supplier, total_amount, receipt_date,
                category, image_filename, batch_title
            ) VALUES
                (gen_random_uuid()::text, $1, 'processed', 'expense', 'Spend Co', 1000, CURRENT_DATE, 'Other', 'a.jpg', 'Batch X'),
                (gen_random_uuid()::text, $1, 'processed', 'quotation', 'Quote Co', 5000, CURRENT_DATE, 'Other', 'b.jpg', 'Batch X')
            """,
            uid,
        )

    groups = await client.get(f"/api/v1/users/{uid}/receipts/groups", headers=headers)
    assert groups.status_code == 200, groups.text
    batch = next(g for g in groups.json()["groups"] if g["batchTitle"] == "Batch X")
    assert batch["count"] == 1
    assert batch["totalAmount"] == 1000.0

    overview = await client.get(f"/api/v1/users/{uid}/dashboard/overview", headers=headers)
    assert overview.status_code == 200, overview.text
    assert overview.json()["total_spent"] == 1000.0
    assert overview.json()["total_receipts"] == 1


@pytest.mark.asyncio
async def test_export_excludes_non_expense_by_default(client):
    from app.core.database import get_pool

    user, headers = await _new_user(client, "exp")
    uid = user["uid"]
    pool = await get_pool()

    await _insert_receipt(pool, uid, "Expense Co", 100, "expense")
    await _insert_receipt(pool, uid, "Proforma Co", 200, "proforma")

    body = {"format": "csv", "reportType": "receipts"}
    default = await client.post(
        f"/api/v1/users/{uid}/receipts/export", json=body, headers=headers
    )
    assert default.status_code == 200, default.text
    text = default.text
    assert "Expense Co" in text
    assert "Proforma Co" not in text

    # Explicit entryType selection wins over the default exclusion.
    register = await client.post(
        f"/api/v1/users/{uid}/receipts/export",
        json={**body, "entryType": "non_expense"},
        headers=headers,
    )
    assert register.status_code == 200, register.text
    assert "Proforma Co" in register.text
    assert "Expense Co" not in register.text

    include = await client.post(
        f"/api/v1/users/{uid}/receipts/export",
        json={**body, "includeNonExpense": True},
        headers=headers,
    )
    assert include.status_code == 200, include.text
    assert "Expense Co" in include.text
    assert "Proforma Co" in include.text
