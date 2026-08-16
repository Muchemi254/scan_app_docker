"""
Tests for the backup feature.

Covers:
  - export creates an archive + metadata row and lists it
  - download works both with the Authorization header AND with a bare
    ?token= query (the cross-device direct-link path that used to 401)
  - cross-tenant download is blocked
  - per-user quota/retention auto-prunes the oldest archives on export
  - quota summary endpoint reports usage
"""

import os

from tests.helpers import ADMIN_EMAIL, ADMIN_PASSWORD, create_user_via_admin, login


async def _admin(client):
    headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    return headers


async def _user(client, admin_headers, email):
    return await create_user_via_admin(client, admin_headers, email, "pass-123")


async def _export(client, headers, uid):
    resp = await client.post(f"/api/v1/users/{uid}/backup/export", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.content


async def _list(client, headers, uid):
    resp = await client.get(f"/api/v1/users/{uid}/backup/list", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _quota(client, headers, uid):
    resp = await client.get(f"/api/v1/users/{uid}/backup/quota", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _set_limits(client, admin_headers, max_bytes, max_count):
    resp = await client.put(
        "/api/v1/settings/global/backup-limits",
        headers=admin_headers,
        json={"max_backup_bytes_per_user": max_bytes, "max_backups_per_user": max_count},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_export_lists_and_downloads(client):
    admin_headers = await _admin(client)
    user = await _user(client, admin_headers, "bkp1@pytest.local")
    headers, _, token = await login(client, "bkp1@pytest.local", "pass-123")
    uid = user["uid"]

    content = await _export(client, headers, uid)
    assert len(content) > 100  # real tar.gz bytes streamed back

    rows = await _list(client, headers, uid)
    assert len(rows) == 1
    entry = rows[0]
    assert entry["available"] is True
    assert entry["user_id"] == uid
    assert entry["size_bytes"] > 0

    # Download via Authorization header.
    resp = await client.get(
        f"/api/v1/users/{uid}/backup/download/{entry['id']}", headers=headers
    )
    assert resp.status_code == 200, resp.text
    assert resp.content == content

    # Quota summary matches.
    q = await _quota(client, headers, uid)
    assert q["count"] == 1
    assert q["used_bytes"] == entry["size_bytes"]


async def test_download_via_query_token_without_header(client):
    """Regression: direct browser <a> download (no Authorization header).

    The endpoint must accept a valid ?token= and serve the archive.
    """
    admin_headers = await _admin(client)
    user = await _user(client, admin_headers, "bkp2@pytest.local")
    headers, _, token = await login(client, "bkp2@pytest.local", "pass-123")
    uid = user["uid"]

    await _export(client, headers, uid)
    entry = (await _list(client, headers, uid))[0]

    resp = await client.get(
        f"/api/v1/users/{uid}/backup/download/{entry['id']}?token={token}"
    )
    assert resp.status_code == 200, resp.text
    assert resp.headers.get("content-type") == "application/gzip"


async def test_download_rejects_bad_or_wrong_token(client):
    admin_headers = await _admin(client)
    user = await _user(client, admin_headers, "bkp3@pytest.local")
    headers, _, _ = await login(client, "bkp3@pytest.local", "pass-123")
    uid = user["uid"]
    await _export(client, headers, uid)
    entry = (await _list(client, headers, uid))[0]

    # No header AND no token → 401.
    resp = await client.get(f"/api/v1/users/{uid}/backup/download/{entry['id']}")
    assert resp.status_code == 401

    # Garbage token → 401.
    resp = await client.get(
        f"/api/v1/users/{uid}/backup/download/{entry['id']}?token=not-a-jwt"
    )
    assert resp.status_code == 401


async def test_cross_tenant_download_blocked(client):
    admin_headers = await _admin(client)
    alice = await _user(client, admin_headers, "bkpA@pytest.local")
    bob = await _user(client, admin_headers, "bkpB@pytest.local")
    ah, _, _ = await login(client, "bkpA@pytest.local", "pass-123")
    bh, _, _ = await login(client, "bkpB@pytest.local", "pass-123")

    await _export(client, ah, alice["uid"])
    entry = (await _list(client, ah, alice["uid"]))[0]

    # Bob (header) trying to fetch Alice's backup → 403.
    resp = await client.get(
        f"/api/v1/users/{alice['uid']}/backup/download/{entry['id']}",
        headers=bh,
    )
    assert resp.status_code == 403

    # Alice's token used against bob's userId path → 403.
    resp = await client.get(
        f"/api/v1/users/{bob['uid']}/backup/download/{entry['id']}"
    )
    assert resp.status_code in (401, 403)

    # Bob listing Alice's backups → 403.
    resp = await client.get(
        f"/api/v1/users/{alice['uid']}/backup/list", headers=bh
    )
    assert resp.status_code == 403


async def test_retention_keeps_newest_backups(client):
    admin_headers = await _admin(client)
    await _set_limits(client, admin_headers, 0, 3)  # unlimited bytes, keep 3
    user = await _user(client, admin_headers, "bkpR@pytest.local")
    headers, _, _ = await login(client, "bkpR@pytest.local", "pass-123")
    uid = user["uid"]

    for _ in range(6):
        await _export(client, headers, uid)

    rows = await _list(client, headers, uid)
    assert len(rows) == 3
    # Newest kept; all listed archives still available on disk.
    assert all(r["available"] for r in rows)
    q = await _quota(client, headers, uid)
    assert q["count"] == 3
    assert q["max_count"] == 3


async def test_byte_quota_prunes_oldest(client):
    admin_headers = await _admin(client)
    user = await _user(client, admin_headers, "bkpQ@pytest.local")
    headers, _, _ = await login(client, "bkpQ@pytest.local", "pass-123")
    uid = user["uid"]

    # One empty backup is ~430 bytes; set a tight byte budget with no
    # retention cap so only byte-quota pruning applies.
    await _set_limits(client, admin_headers, 1_000, 0)
    for _ in range(4):
        await _export(client, headers, uid)

    rows = await _list(client, headers, uid)
    q = await _quota(client, headers, uid)
    assert q["count"] == len(rows)
    assert q["used_bytes"] <= 1_000
    assert 1 <= len(rows) <= 3  # pruned to fit within the byte budget
    assert all(r["available"] for r in rows)


async def test_delete_backup_removes_file_and_row(client):
    admin_headers = await _admin(client)
    user = await _user(client, admin_headers, "bkpD@pytest.local")
    headers, _, _ = await login(client, "bkpD@pytest.local", "pass-123")
    uid = user["uid"]
    await _export(client, headers, uid)
    entry = (await _list(client, headers, uid))[0]

    resp = await client.delete(
        f"/api/v1/users/{uid}/backup/{entry['id']}", headers=headers
    )
    assert resp.status_code == 204

    rows = await _list(client, headers, uid)
    assert rows == []

    # Download of the deleted backup → 404.
    resp = await client.get(
        f"/api/v1/users/{uid}/backup/download/{entry['id']}", headers=headers
    )
    assert resp.status_code == 404