"""
Integration tests for the local-auth endpoints (AUTH_MODE=local):

  POST   /api/v1/auth/login
  GET    /api/v1/auth/me
  POST   /api/v1/auth/admin/users
  GET    /api/v1/auth/admin/users
  DELETE /api/v1/auth/admin/users/{uid}
"""

from tests.helpers import (
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    create_user_via_admin,
    login,
)


# ── Public endpoints ────────────────────────────────────────────────────────

async def test_me_requires_bearer_token(client):
    resp = await client.get("/api/v1/auth/me")
    assert resp.status_code in (401, 403)


async def test_login_bootstrap_admin(client):
    headers, user, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    assert user["is_admin"] is True
    assert user["email"] == ADMIN_EMAIL
    assert user["uid"]

    resp = await client.get("/api/v1/auth/me", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["uid"] == user["uid"]
    assert resp.json()["email"] == ADMIN_EMAIL


async def test_login_wrong_password(client):
    resp = await client.post(
        "/api/v1/auth/login",
        json={"email": ADMIN_EMAIL, "password": "definitely-wrong"},
    )
    assert resp.status_code == 401


async def test_login_unknown_email(client):
    resp = await client.post(
        "/api/v1/auth/login",
        json={"email": "ghost@pytest.local", "password": "whatever"},
    )
    assert resp.status_code == 401


async def test_me_rejects_garbage_token(client):
    resp = await client.get(
        "/api/v1/auth/me", headers={"Authorization": "Bearer garbage.token.here"}
    )
    assert resp.status_code == 401


# ── Admin user management ───────────────────────────────────────────────────

async def test_admin_create_user_then_login(client):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)

    created = await create_user_via_admin(
        client, admin_headers, "alice@pytest.local", "alice-pass-1"
    )
    assert created["email"] == "alice@pytest.local"
    assert created["is_admin"] is False
    assert created["uid"]

    headers, user, _ = await login(client, "alice@pytest.local", "alice-pass-1")
    assert user["uid"] == created["uid"]
    assert user["is_admin"] is False


async def test_non_admin_cannot_use_admin_endpoints(client):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    await create_user_via_admin(client, admin_headers, "mike@pytest.local", "mike-pass")

    user_headers, _, _ = await login(client, "mike@pytest.local", "mike-pass")

    resp = await client.get("/api/v1/auth/admin/users", headers=user_headers)
    assert resp.status_code == 403

    resp = await client.post(
        "/api/v1/auth/admin/users",
        headers=user_headers,
        json={"email": "blocked@pytest.local", "password": "x"},
    )
    assert resp.status_code == 403


async def test_admin_create_duplicate_email_is_conflict(client):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    await create_user_via_admin(client, admin_headers, "carol@pytest.local", "carol-pass")

    resp = await client.post(
        "/api/v1/auth/admin/users",
        headers=admin_headers,
        json={"email": "CAROL@PYTEST.LOCAL", "password": "other-pass"},  # case-insensitive
    )
    assert resp.status_code == 409


async def test_admin_list_and_delete_user(client):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    bob = await create_user_via_admin(client, admin_headers, "bob@pytest.local", "bob-pass")

    listing = await client.get("/api/v1/auth/admin/users", headers=admin_headers)
    assert listing.status_code == 200
    uids = [u["uid"] for u in listing.json()]
    assert bob["uid"] in uids

    resp = await client.delete(f"/api/v1/auth/admin/users/{bob['uid']}", headers=admin_headers)
    assert resp.status_code == 204

    listing = await client.get("/api/v1/auth/admin/users", headers=admin_headers)
    assert bob["uid"] not in [u["uid"] for u in listing.json()]


async def test_deleted_user_token_is_rejected(client):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    dave = await create_user_via_admin(client, admin_headers, "dave@pytest.local", "dave-pass")
    dave_headers, dave_user, _ = await login(client, "dave@pytest.local", "dave-pass")

    resp = await client.get("/api/v1/auth/me", headers=dave_headers)
    assert resp.status_code == 200

    await client.delete(f"/api/v1/auth/admin/users/{dave_user['uid']}", headers=admin_headers)

    resp = await client.get("/api/v1/auth/me", headers=dave_headers)
    assert resp.status_code == 401


# ── Guards ──────────────────────────────────────────────────────────────────

async def test_admin_cannot_delete_self(client):
    admin_headers, admin_user, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    resp = await client.delete(
        f"/api/v1/auth/admin/users/{admin_user['uid']}", headers=admin_headers
    )
    assert resp.status_code == 403


async def test_admin_cannot_delete_the_last_admin(client):
    admin_headers, admin_user, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)

    # Two admins: bootstrap + second. Deleting the second is fine.
    second = await create_user_via_admin(
        client, admin_headers, "second@pytest.local", "second-pass", is_admin=True
    )
    resp = await client.delete(f"/api/v1/auth/admin/users/{second['uid']}", headers=admin_headers)
    assert resp.status_code == 204

    # Now one admin remains. Deleting the bootstrap admin must be blocked.
    resp = await client.delete(
        f"/api/v1/auth/admin/users/{admin_user['uid']}", headers=admin_headers
    )
    assert resp.status_code in (400, 403)


async def test_admin_delete_unknown_user_is_404(client):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    resp = await client.delete(
        "/api/v1/auth/admin/users/no-such-user", headers=admin_headers
    )
    assert resp.status_code == 404
