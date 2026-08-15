"""
Tests for the admin-gated 'super_processed' receipt status.

Rules:
  - Only admin accounts may create or update a receipt to super_processed.
  - Non-admins get 403 when they try; the status still accepts the value
    at the schema level so admins can round-trip it.
"""

import json

from tests.helpers import (
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    create_user_via_admin,
    login,
    sample_receipt,
)


def _create_payload(**overrides):
    data = sample_receipt()
    data.update(overrides)
    return json.dumps(data)


async def _new_user(client, admin_headers, email, is_admin=False):
    return await create_user_via_admin(
        client, admin_headers, email, "pass-123", is_admin=is_admin
    )


async def _create_receipt(client, headers, uid, status=None, extra=None):
    payload = _create_payload(**({"status": status} if status else {}))
    files = {"receipt_data": (None, payload)}
    if extra:
        files.update(extra)
    return await client.post(
        f"/api/v1/users/{uid}/receipts", headers=headers, files=files
    )


async def test_admin_can_mark_super_processed_on_create(client):
    admin_headers, admin, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)

    resp = await _create_receipt(client, admin_headers, admin["uid"], status="super_processed")
    assert resp.status_code == 201, resp.text
    assert resp.json()["status"] == "super_processed"


async def test_non_admin_cannot_create_super_processed(client):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    alice = await _new_user(client, admin_headers, "alice@pytest.local")
    alice_headers, _, _ = await login(client, "alice@pytest.local", "pass-123")

    resp = await _create_receipt(client, alice_headers, alice["uid"], status="super_processed")
    assert resp.status_code == 403, resp.text

    # Non-admin can still create ordinary processed receipts
    resp = await _create_receipt(client, alice_headers, alice["uid"], status="processed")
    assert resp.status_code == 201, resp.text
    assert resp.json()["status"] == "processed"


async def test_non_admin_cannot_update_to_super_processed(client):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    alice = await _new_user(client, admin_headers, "alice@pytest.local")
    alice_headers, _, _ = await login(client, "alice@pytest.local", "pass-123")

    created = await _create_receipt(client, alice_headers, alice["uid"], status="processed")
    receipt_id = created.json()["id"]

    resp = await client.put(
        f"/api/v1/users/{alice['uid']}/receipts/{receipt_id}",
        headers=alice_headers,
        files={"receipt_data": (None, json.dumps({"status": "super_processed"}))},
    )
    assert resp.status_code == 403, resp.text

    # Non-admin may still move it to processed
    resp = await client.put(
        f"/api/v1/users/{alice['uid']}/receipts/{receipt_id}",
        headers=alice_headers,
        files={"receipt_data": (None, json.dumps({"status": "processed"}))},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "processed"


async def test_admin_can_update_to_super_processed(client):
    admin_headers, admin, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)

    created = await _create_receipt(client, admin_headers, admin["uid"], status="processed")
    receipt_id = created.json()["id"]

    resp = await client.put(
        f"/api/v1/users/{admin['uid']}/receipts/{receipt_id}",
        headers=admin_headers,
        files={"receipt_data": (None, json.dumps({"status": "super_processed"}))},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "super_processed"


async def test_super_processed_receipt_lists_with_status_filter(client):
    admin_headers, admin, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    await _create_receipt(client, admin_headers, admin["uid"], status="super_processed")

    resp = await client.get(
        f"/api/v1/users/{admin['uid']}/receipts",
        headers=admin_headers,
        params={"status": "super_processed"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["total"] == 1
    assert resp.json()["items"][0]["status"] == "super_processed"
