"""
Tests for the admin-managed trusted-hosts whitelist.

  GET  /api/v1/auth/admin/settings/trusted-hosts   (admin only)
  PUT  /api/v1/auth/admin/settings/trusted-hosts   (admin only)

Covers persistence, live application to the dynamic Host check, admin
authorization, and input validation.
"""

from tests.helpers import ADMIN_EMAIL, ADMIN_PASSWORD, create_user_via_admin, login


async def _admin_headers(client):
    headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    return headers


async def test_get_trusted_hosts_default(client):
    headers = await _admin_headers(client)
    resp = await client.get("/api/v1/auth/admin/settings/trusted-hosts", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["hosts"] == ["*"]


async def test_update_and_persist_trusted_hosts(client):
    headers = await _admin_headers(client)

    resp = await client.put(
        "/api/v1/auth/admin/settings/trusted-hosts",
        headers=headers,
        json={"hosts": ["192.168.1.195:8081", "MY-NAS", "*"]},
    )
    assert resp.status_code == 200
    assert resp.json()["hosts"] == ["*", "192.168.1.195", "my-nas"]

    resp = await client.get("/api/v1/auth/admin/settings/trusted-hosts", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["hosts"] == ["*", "192.168.1.195", "my-nas"]


async def test_trusted_hosts_are_persisted_in_db(client):
    headers = await _admin_headers(client)
    await client.put(
        "/api/v1/auth/admin/settings/trusted-hosts",
        headers=headers,
        json={"hosts": ["office-wifi.lan"]},
    )

    from app.services import app_settings_service
    persisted = await app_settings_service.get_trusted_hosts()
    assert persisted == ["office-wifi.lan"]


async def test_host_check_applies_live_after_update(client):
    admin_headers = await _admin_headers(client)
    user_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)

    allowed_host = "192.168.1.195:8081"
    denied_host = "evil.example.com:8081"

    # Default "*" allows anything.
    resp = await client.get(
        "/api/v1/auth/me",
        headers={**user_headers, "host": denied_host},
    )
    assert resp.status_code == 200

    # Restrict to a specific host.
    await client.put(
        "/api/v1/auth/admin/settings/trusted-hosts",
        headers=admin_headers,
        json={"hosts": ["192.168.1.195"]},
    )

    resp = await client.get(
        "/api/v1/auth/me",
        headers={**user_headers, "host": allowed_host},
    )
    assert resp.status_code == 200
    resp = await client.get(
        "/api/v1/auth/me",
        headers={**user_headers, "host": denied_host},
    )
    assert resp.status_code == 400
    assert resp.json()["detail"] == "Invalid host header"


async def test_non_admin_cannot_manage_trusted_hosts(client):
    admin_headers = await _admin_headers(client)
    await create_user_via_admin(client, admin_headers, "host@pytest.local", "host-pass")
    user_headers, _, _ = await login(client, "host@pytest.local", "host-pass")

    resp = await client.get("/api/v1/auth/admin/settings/trusted-hosts", headers=user_headers)
    assert resp.status_code == 403
    resp = await client.put(
        "/api/v1/auth/admin/settings/trusted-hosts",
        headers=user_headers,
        json={"hosts": ["*"]},
    )
    assert resp.status_code == 403


async def test_invalid_host_entry_rejected(client):
    headers = await _admin_headers(client)
    resp = await client.put(
        "/api/v1/auth/admin/settings/trusted-hosts",
        headers=headers,
        json={"hosts": ["http://evil.example.com/path"]},
    )
    assert resp.status_code == 400
