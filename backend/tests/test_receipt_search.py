import pytest

from tests.helpers import ADMIN_EMAIL, ADMIN_PASSWORD, create_user_via_admin, login


async def _admin(client):
    headers, user, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    return headers, user


@pytest.mark.asyncio
async def test_receipt_search_matches_items_paginates_and_applies_filters(client):
    from app.core.database import get_pool

    admin_headers, _ = await _admin(client)
    user = await create_user_via_admin(
        client, admin_headers, "search_regression@pytest.local", "testpass123"
    )
    headers, _, _ = await login(client, "search_regression@pytest.local", "testpass123")
    pool = await get_pool()

    async with pool.acquire() as conn:
        for category, item_name in (("Food", "Search Widget"), ("Office", "Search Widget"), ("Food", "Different Item")):
            await conn.execute(
                """
                WITH new_receipt AS (
                    INSERT INTO receipts (
                        id, user_id, status, supplier, total_amount, receipt_date, category
                    ) VALUES (
                        gen_random_uuid()::text, $1, 'processed', 'Search Supplier', 10,
                        CURRENT_DATE, $2
                    ) RETURNING id
                )
                INSERT INTO line_items (receipt_id, sort_order, name, quantity, price, tax, is_zero_rated)
                SELECT id, 0, $3, 2, 4, 2, false FROM new_receipt
                """,
                user["uid"],
                category,
                item_name,
            )

    first = await client.get(
        f"/api/v1/users/{user['uid']}/receipts/search",
        params={"q": "Search Widget", "limit": 1},
        headers=headers,
    )
    assert first.status_code == 200, first.text
    assert first.json()["total"] == 2
    assert len(first.json()["results"]) == 1

    second = await client.get(
        f"/api/v1/users/{user['uid']}/receipts/search",
        params={"q": "Search Widget", "limit": 1, "offset": 1},
        headers=headers,
    )
    assert second.status_code == 200, second.text
    assert second.json()["total"] == 2
    assert second.json()["results"][0]["id"] != first.json()["results"][0]["id"]

    filtered = await client.get(
        f"/api/v1/users/{user['uid']}/receipts/search",
        params={"q": "Search Widget", "category": "Office"},
        headers=headers,
    )
    assert filtered.status_code == 200, filtered.text
    assert filtered.json()["total"] == 1
    assert filtered.json()["results"][0]["category"] == "Office"

    wildcard = await client.get(
        f"/api/v1/users/{user['uid']}/receipts/search",
        params={"q": "%"},
        headers=headers,
    )
    assert wildcard.status_code == 200, wildcard.text
    assert wildcard.json()["total"] == 0


@pytest.mark.asyncio
async def test_admin_pending_search_paginates(client):
    admin_headers, _ = await _admin(client)
    user = await create_user_via_admin(
        client, admin_headers, "admin_search_regression@pytest.local", "testpass123"
    )
    from app.core.database import get_pool

    pool = await get_pool()
    async with pool.acquire() as conn:
        for item_name in ("Admin Search One", "Admin Search Two"):
            await conn.execute(
                """
                WITH new_receipt AS (
                    INSERT INTO receipts (
                        id, user_id, status, supplier, total_amount, receipt_date, category
                    ) VALUES (
                        gen_random_uuid()::text, $1, 'pending_approval', 'Admin Supplier', 10,
                        CURRENT_DATE, 'Office'
                    ) RETURNING id
                )
                INSERT INTO line_items (receipt_id, sort_order, name, quantity, price, tax, is_zero_rated)
                SELECT id, 0, $2, 1, 10, 0, false FROM new_receipt
                """,
                user["uid"],
                item_name,
            )

    first = await client.get(
        "/api/v1/admin/receipts/pending-approval",
        params={"q": "Admin Search", "limit": 1},
        headers=admin_headers,
    )
    assert first.status_code == 200, first.text
    assert first.json()["total"] == 2
    assert len(first.json()["items"]) == 1

    second = await client.get(
        "/api/v1/admin/receipts/pending-approval",
        params={"q": "Admin Search", "limit": 1, "offset": 1},
        headers=admin_headers,
    )
    assert second.status_code == 200, second.text
    assert second.json()["total"] == 2
    assert second.json()["items"][0]["id"] != first.json()["items"][0]["id"]
