"""
Tests for configurable tax rate:
  - per-user default via GET/PUT /users/{uid}/settings/tax
  - admin-managed global default via GET/PUT /settings/global/tax-rate
  - resolution: personal default > global default > 16
"""

from tests.helpers import ADMIN_EMAIL, ADMIN_PASSWORD, create_user_via_admin, login


async def _non_admin(client, admin_headers, email="taxer@pytest.local"):
    user = await create_user_via_admin(client, admin_headers, email, "pass-123")
    ah, _, _ = await login(client, email, "pass-123")
    return user["uid"], ah


async def test_default_tax_preference(client):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    uid, ah = await _non_admin(client, admin_headers)

    resp = await client.get(f"/api/v1/users/{uid}/settings/tax", headers=ah)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"default_tax_rate": 16.0, "global_default": 16.0}


async def test_user_can_set_own_tax_preference(client):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    uid, ah = await _non_admin(client, admin_headers)

    resp = await client.put(
        f"/api/v1/users/{uid}/settings/tax", headers=ah, json={"default_tax_rate": 20}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["default_tax_rate"] == 20.0

    resp = await client.get(f"/api/v1/users/{uid}/settings/tax", headers=ah)
    assert resp.json()["default_tax_rate"] == 20.0

    # invalid rates rejected
    for bad in [-1, 101]:
        r = await client.put(
            f"/api/v1/users/{uid}/settings/tax", headers=ah, json={"default_tax_rate": bad}
        )
        assert r.status_code == 422, r.text


async def test_global_tax_rate_admin_only(client):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    uid, ah = await _non_admin(client, admin_headers)

    # non-admin cannot change the global default
    resp = await client.put(
        "/api/v1/settings/global/tax-rate", headers=ah, json={"default_tax_rate": 22}
    )
    assert resp.status_code == 403, resp.text

    # admin changes global default
    resp = await client.put(
        "/api/v1/settings/global/tax-rate", headers=admin_headers, json={"default_tax_rate": 22}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["default_tax_rate"] == 22.0

    resp = await client.get("/api/v1/settings/global/tax-rate", headers=admin_headers)
    assert resp.json()["default_tax_rate"] == 22.0


async def test_global_default_is_fallback_for_personal(client):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)

    await client.put(
        "/api/v1/settings/global/tax-rate", headers=admin_headers, json={"default_tax_rate": 22}
    )

    # user with no personal default picks up the global default
    uid, ah = await _non_admin(client, admin_headers, email="fallback@pytest.local")
    resp = await client.get(f"/api/v1/users/{uid}/settings/tax", headers=ah)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"default_tax_rate": 22.0, "global_default": 22.0}

    # personal default overrides the global default
    await client.put(
        f"/api/v1/users/{uid}/settings/tax", headers=ah, json={"default_tax_rate": 14}
    )
    resp = await client.get(f"/api/v1/users/{uid}/settings/tax", headers=ah)
    assert resp.json()["default_tax_rate"] == 14.0