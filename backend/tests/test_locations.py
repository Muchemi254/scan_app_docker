"""
Tests for the admin-managed locations reference data API.

Locations are created/edited/deleted by admins only; any authenticated user
may read the active list (drives the reviewer's location picker). A receipt's
location is stored as a free-text snapshot, so approvals do not depend on a
location actually existing in this table — but the gate logic is tested in
test_workflow.py.
"""

import json

from tests.helpers import ADMIN_EMAIL, ADMIN_PASSWORD, create_user_via_admin, login, sample_receipt


async def _non_admin(client, admin_headers, email="locuser@pytest.local"):
    user = await create_user_via_admin(client, admin_headers, email, "pass-123")
    ah, _, _ = await login(client, email, "pass-123")
    return user["uid"], ah


async def _list(client, headers=None):
    resp = await client.get("/api/v1/locations", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_auth_required_for_locations(client):
    resp = await client.get("/api/v1/locations")
    assert resp.status_code in (401, 403), resp.text


async def test_non_admin_can_list_active_locations(client):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    _, ah = await _non_admin(client, admin_headers)

    created = await client.post(
        "/api/v1/locations",
        headers=admin_headers,
        json={"name": "Kampala Branch"},
    )
    assert created.status_code == 201, created.text

    items = await _list(client, ah)
    assert items["total"] == 1
    assert items["items"][0]["name"] == "Kampala Branch"


async def test_non_admin_cannot_write_locations(client):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    uid, ah = await _non_admin(client, admin_headers)

    for method, url, body in [
        ("POST", "/api/v1/locations", {"name": "Nope"}),
        ("PUT", "/api/v1/locations/some-id", {"name": "Nope 2"}),
        ("DELETE", "/api/v1/locations/some-id", None),
    ]:
        resp = await client.request(method, url, headers=ah, json=body)
        assert resp.status_code == 403, f"{method} {url}: {resp.status_code} {resp.text}"


async def test_admin_location_crud(client):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)

    # create
    created = await client.post(
        "/api/v1/locations", headers=admin_headers, json={"name": "Nairobi HQ"}
    )
    assert created.status_code == 201, created.text
    loc = created.json()
    assert loc["name"] == "Nairobi HQ"
    assert loc["is_active"] is True

    # duplicate name → 409
    dup = await client.post(
        "/api/v1/locations", headers=admin_headers, json={"name": "Nairobi HQ"}
    )
    assert dup.status_code == 409, dup.text

    # update
    updated = await client.put(
        f"/api/v1/locations/{loc['id']}",
        headers=admin_headers,
        json={"name": "Nairobi HQ 2", "is_active": False},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["name"] == "Nairobi HQ 2"
    assert updated.json()["is_active"] is False

    # inactive locations are hidden from the auth-only list
    items = await _list(client, admin_headers)
    assert items["total"] == 0

    # delete
    deleted = await client.delete(
        f"/api/v1/locations/{loc['id']}", headers=admin_headers
    )
    assert deleted.status_code == 204, deleted.text

    # delete unknown id → 404
    resp = await client.delete(
        f"/api/v1/locations/{loc['id']}", headers=admin_headers
    )
    assert resp.status_code == 404, resp.text