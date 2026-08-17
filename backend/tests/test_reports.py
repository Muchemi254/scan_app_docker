"""Comprehensive reporting system tests.

Covers: catalog scoping (owner vs admin reports), tenant isolation, sensitive
column exclusion, formats (csv/xlsx/pdf/json), filters, date ranges, unknown
reports, non-admin include_sensitive rejection and export auditing.
"""

import json

import pytest

from tests.helpers import ADMIN_EMAIL, ADMIN_PASSWORD, create_user_via_admin, login


async def _admin(client):
    headers, user, token = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    return headers, user, token


async def _create_user(client, admin_headers, email: str, is_admin: bool = False) -> dict:
    return await create_user_via_admin(
        client, admin_headers, email, "testpass123", isAdmin=is_admin
    )


async def _insert_receipt(
    pool, user_id: str, total: float, supplier: str = "Acme"
) -> str:
    async with pool.acquire() as conn:
        receipt_id = await conn.fetchval(
            """
            INSERT INTO receipts (id, user_id, status, supplier, total_amount,
                                  tax_amount, receipt_date, category)
            VALUES (gen_random_uuid()::text, $1, 'approved', $2, $3, $4, CURRENT_DATE, 'Food')
            RETURNING id
            """,
            user_id,
            supplier,
            total,
            round(total * 0.16, 2),
        )
        await conn.execute(
            """
            INSERT INTO line_items (receipt_id, sort_order, name, quantity, price, tax, is_zero_rated, tax_rate)
            VALUES ($1, 0, 'Sample item', 1, $2, $3, false, 16)
            """,
            receipt_id,
            total,
            round(total * 0.16, 2),
        )
    return receipt_id


@pytest.mark.asyncio
async def test_catalog_scoping(client):
    admin_headers, _, _ = await _admin(client)
    await _create_user(client, admin_headers, "owner_catalog@pytest.local")

    admin_cat = await client.get("/api/v1/reports", headers=admin_headers)
    assert admin_cat.status_code == 200
    admin_keys = {r["key"] for r in admin_cat.json()["reports"]}
    assert "receipts_register" in admin_keys
    assert "users" in admin_keys
    assert "audit_trail" in admin_keys
    assert "messages" in admin_keys
    assert "app_settings" in admin_keys

    owner_headers, _, _ = await login(client, "owner_catalog@pytest.local", "testpass123")
    owner_cat = await client.get("/api/v1/reports", headers=owner_headers)
    assert owner_cat.status_code == 200
    owner_keys = {r["key"] for r in owner_cat.json()["reports"]}
    assert "receipts_register" in owner_keys
    assert "users" not in owner_keys
    assert "audit_trail" not in owner_keys
    assert "messages" not in owner_keys
    assert "app_settings" not in owner_keys

    assert "password_hash" not in json.dumps(admin_cat.json())


@pytest.mark.asyncio
async def test_owner_only_sees_own_receipts(client):
    from app.core.database import get_pool

    admin_headers, admin_user, _ = await _admin(client)
    alice = await _create_user(client, admin_headers, "alice_reports@pytest.local")
    bob = await _create_user(client, admin_headers, "bob_reports@pytest.local")

    pool = await get_pool()
    await _insert_receipt(pool, alice["uid"], 100.0)
    await _insert_receipt(pool, bob["uid"], 250.0)
    await _insert_receipt(pool, admin_user["uid"], 50.0)

    alice_headers, _, _ = await login(client, "alice_reports@pytest.local", "testpass123")
    resp = await client.post(
        "/api/v1/reports/receipts_register/export",
        json={"format": "json"},
        headers=alice_headers,
    )
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["summary"]["row_count"] == 1
    assert "Total amount (KES)" in payload["summary"]
    assert payload["summary"]["Total amount (KES)"] == 100.0

    admin_resp = await client.post(
        "/api/v1/reports/receipts_register/export",
        json={"format": "json", "includeSensitive": True},
        headers=admin_headers,
    )
    assert admin_resp.status_code == 200
    owner_users = {row["r_user_id"] for row in admin_resp.json()["rows"]}
    assert owner_users == {alice["uid"], bob["uid"], admin_user["uid"]}


@pytest.mark.asyncio
async def test_sensitive_columns_excluded_for_owner(client):
    from app.core.database import get_pool

    admin_headers, _, _ = await _admin(client)
    carol = await _create_user(client, admin_headers, "carol_reports@pytest.local")
    pool = await get_pool()
    await _insert_receipt(pool, carol["uid"], 42.0)

    headers, _, _ = await login(client, "carol_reports@pytest.local", "testpass123")
    resp = await client.post(
        "/api/v1/reports/receipts_register/export",
        json={"format": "json"},
        headers=headers,
    )
    assert resp.status_code == 200
    payload = resp.json()
    col_keys = {c["key"] for c in payload["columns"]}
    assert "r_user_id" not in col_keys
    assert "r_kra_pin" not in col_keys
    assert "r_buyer_kra_pin" not in col_keys
    assert "r_supplier" in col_keys


@pytest.mark.asyncio
async def test_admin_can_include_sensitive(client):
    admin_headers, _, _ = await _admin(client)

    resp = await client.post(
        "/api/v1/reports/users/export",
        json={"format": "json"},
        headers=admin_headers,
    )
    assert resp.status_code == 200
    col_keys = {c["key"] for c in resp.json()["columns"]}
    assert "u_email" not in col_keys
    assert "u_uid" not in col_keys

    resp = await client.post(
        "/api/v1/reports/users/export",
        json={"format": "json", "includeSensitive": True},
        headers=admin_headers,
    )
    assert resp.status_code == 200
    col_keys = {c["key"] for c in resp.json()["columns"]}
    assert "u_email" in col_keys
    assert "u_uid" in col_keys


@pytest.mark.asyncio
async def test_non_admin_cannot_include_sensitive(client):
    admin_headers, _, _ = await _admin(client)
    await _create_user(client, admin_headers, "dave_reports@pytest.local")
    headers, _, _ = await login(client, "dave_reports@pytest.local", "testpass123")
    resp = await client.post(
        "/api/v1/reports/users/export",
        json={"format": "json", "includeSensitive": True},
        headers=headers,
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_admin_only_report_forbidden_for_owner(client):
    admin_headers, _, _ = await _admin(client)
    await _create_user(client, admin_headers, "erin_reports@pytest.local")
    headers, _, _ = await login(client, "erin_reports@pytest.local", "testpass123")
    resp = await client.post(
        "/api/v1/reports/audit_trail/export",
        json={"format": "json"},
        headers=headers,
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_unknown_report_404(client):
    admin_headers, _, _ = await _admin(client)
    resp = await client.post(
        "/api/v1/reports/nope/export",
        json={"format": "json"},
        headers=admin_headers,
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_invalid_filter_400(client):
    admin_headers, _, _ = await _admin(client)
    resp = await client.post(
        "/api/v1/reports/receipts_register/export",
        json={"format": "json", "filters": {"bogus": "x"}},
        headers=admin_headers,
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_status_filter(client):
    from app.core.database import get_pool

    admin_headers, admin_user, _ = await _admin(client)
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO receipts (id, user_id, status, supplier, total_amount, receipt_date)
            VALUES (gen_random_uuid()::text, $1, 'needs_review', 'FilterCo', 5, CURRENT_DATE)
            """,
            admin_user["uid"],
        )
    ok = await client.post(
        "/api/v1/reports/receipts_register/export",
        json={"format": "json", "filters": {"status": "needs_review"}},
        headers=admin_headers,
    )
    assert ok.status_code == 200
    assert ok.json()["summary"]["row_count"] == 1
    none = await client.post(
        "/api/v1/reports/receipts_register/export",
        json={"format": "json", "filters": {"status": "processed"}},
        headers=admin_headers,
    )
    assert none.json()["summary"]["row_count"] == 0


@pytest.mark.asyncio
async def test_date_range_filter(client):
    from app.core.database import get_pool

    admin_headers, admin_user, _ = await _admin(client)
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO receipts (id, user_id, status, supplier, total_amount, receipt_date)
            VALUES (gen_random_uuid()::text, $1, 'approved', 'OldCo', 1, CURRENT_DATE - 90)
            """,
            admin_user["uid"],
        )
    resp = await client.post(
        "/api/v1/reports/receipts_register/export",
        json={"format": "json", "dateFrom": "2026-01-01", "dateTo": "2026-01-31"},
        headers=admin_headers,
    )
    assert resp.status_code == 200, resp.text


@pytest.mark.asyncio
async def test_formats_csv_xlsx_pdf(client):
    admin_headers, _, _ = await _admin(client)
    for fmt in ("csv", "xlsx", "pdf"):
        resp = await client.post(
            "/api/v1/reports/locations/export",
            json={"format": fmt},
            headers=admin_headers,
        )
        assert resp.status_code == 200, resp.text
        assert len(resp.content) > 0
        assert "attachment" in resp.headers.get("content-disposition", "")
    csv_resp = await client.post(
        "/api/v1/reports/receipts_register/export",
        json={"format": "csv"},
        headers=admin_headers,
    )
    assert csv_resp.status_code == 200
    assert csv_resp.content.startswith(b"\xef\xbb\xbf")


@pytest.mark.asyncio
async def test_export_is_audited(client):
    from app.core.database import get_pool

    admin_headers, admin_user, _ = await _admin(client)
    resp = await client.post(
        "/api/v1/reports/receipts_register/export",
        json={"format": "csv"},
        headers=admin_headers,
    )
    assert resp.status_code == 200
    pool = await get_pool()
    async with pool.acquire() as conn:
        entry = await conn.fetchrow(
            """
            SELECT action, changed_by FROM audit_logs
            WHERE action = 'report_export'
            ORDER BY timestamp DESC LIMIT 1
            """
        )
    assert entry is not None
    assert entry["action"] == "report_export"
    assert entry["changed_by"] == admin_user["uid"]


@pytest.mark.asyncio
async def test_tax_summary_aggregate(client):
    from app.core.database import get_pool

    admin_headers, admin_user, _ = await _admin(client)
    pool = await get_pool()
    await _insert_receipt(pool, admin_user["uid"], 100.0)
    await _insert_receipt(pool, admin_user["uid"], 50.0)

    resp = await client.post(
        "/api/v1/reports/tax_summary/export",
        json={"format": "json"},
        headers=admin_headers,
    )
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert payload["summary"]["row_count"] == 1
    row = payload["rows"][0]
    assert row["sum_l_price"] == 150.0
    assert row["count"] == 2


@pytest.mark.asyncio
async def test_conversation_tenant_scoping(client):
    from app.core.database import get_pool

    admin_headers, admin_user, _ = await _admin(client)
    frank = await _create_user(client, admin_headers, "frank_reports@pytest.local")
    hank = await _create_user(client, admin_headers, "hank_reports@pytest.local")

    def pair(a: str, b: str):
        return (a, b) if a < b else (b, a)

    pool = await get_pool()
    async with pool.acquire() as conn:
        f, h = pair(frank["uid"], hank["uid"])
        await conn.execute(
            """
            INSERT INTO conversations (id, user_a, user_b, kind)
            VALUES (gen_random_uuid(), $1, $2, 'pair')
            """,
            f,
            h,
        )
        h2, a2 = pair(hank["uid"], admin_user["uid"])
        await conn.execute(
            """
            INSERT INTO conversations (id, user_a, user_b, kind)
            VALUES (gen_random_uuid(), $1, $2, 'pair')
            """,
            h2,
            a2,
        )
    headers, _, _ = await login(client, "frank_reports@pytest.local", "testpass123")
    resp = await client.post(
        "/api/v1/reports/conversations/export",
        json={"format": "json"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["summary"]["row_count"] == 1