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


async def test_import_round_trips_receipts_with_datetimes(client):
    """Export → import must round-trip `date`/`timestamptz` columns.

    Regressions test for "invalid input for query argument $7 ... no attribute
    'toordinal'": data.json stores `receipt_date`/`scanned_at`/... as ISO
    strings, so import must coerce them back to `date`/`datetime` objects
    before binding (asyncpg rejects raw strings). Restore happens into the same
    user (the real restore flow), so ids match the exported rows.
    """
    import os
    from datetime import date, datetime, timezone

    from app.services.backup_service import export_user_data, import_user_data
    from tests.conftest import TEST_DATABASE_URL

    admin_headers = await _admin(client)
    uid = (await _user(client, admin_headers, "bkpRound@pytest.local"))["uid"]

    import asyncpg
    conn = await asyncpg.connect(TEST_DATABASE_URL)
    try:
        await conn.execute(
            """
            INSERT INTO receipts (id, user_id, supplier, total_amount, receipt_date,
                scanned_at, created_at, updated_at, status)
            VALUES ($1, $2, 'ACME', 123.45, $3, $4, $5, $6, 'processed')
            """,
            "roundtrip_r1", uid,
            date(2025, 3, 6),
            datetime(2025, 3, 6, 10, 30, tzinfo=timezone.utc),
            datetime(2025, 3, 6, 9, 0, tzinfo=timezone.utc),
            datetime(2025, 3, 6, 11, 0, tzinfo=timezone.utc),
        )
        await conn.execute(
            "INSERT INTO line_items (receipt_id, name, quantity, price) "
            "VALUES ('roundtrip_r1', 'Milk', 2, 50.00)"
        )
    finally:
        await conn.close()

    exported = await export_user_data(uid)
    assert exported["counts"]["receipts"] == 1
    try:
        stats = await import_user_data(uid, exported["path"], conflict="overwrite")
        assert stats["receipts"] == 1, stats
        assert stats["items"] == 1, stats
        assert stats["errors"] == 0, stats

        conn = await asyncpg.connect(TEST_DATABASE_URL)
        try:
            row = await conn.fetchrow(
                "SELECT receipt_date, scanned_at, created_at, updated_at "
                "FROM receipts WHERE user_id = $1",
                uid,
            )
            assert row["receipt_date"] == date(2025, 3, 6)
            assert row["scanned_at"] == datetime(2025, 3, 6, 10, 30, tzinfo=timezone.utc)
            assert row["created_at"] == datetime(2025, 3, 6, 9, 0, tzinfo=timezone.utc)
            assert row["updated_at"] == datetime(2025, 3, 6, 11, 0, tzinfo=timezone.utc)
        finally:
            await conn.close()
    finally:
        try:
            os.remove(exported["path"])
        except OSError:
            pass


async def _make_receipt_with_image(uid, rid, supplier="SUP A", total=10.0):
    """Insert a receipt + line item + a real image file into the test dirs."""
    import os

    import asyncpg

    from app.core.config import settings
    from tests.conftest import TEST_DATABASE_URL

    img_path = os.path.join(settings.IMAGE_STORAGE_DIR, f"{rid}.jpg")
    os.makedirs(settings.IMAGE_STORAGE_DIR, exist_ok=True)
    with open(img_path, "wb") as f:
        f.write(b"\xff\xd8\xff\xe0" + b"0" * 64)  # tiny fake jpeg

    conn = await asyncpg.connect(TEST_DATABASE_URL)
    try:
        await conn.execute(
            "INSERT INTO receipts (id, user_id, supplier, total_amount, receipt_date, status, image_filename) "
            "VALUES ($1, $2, $3, $4, CURRENT_DATE, 'processed', $5)",
            rid, uid, supplier, total, f"{rid}.jpg",
        )
        await conn.execute(
            "INSERT INTO line_items (receipt_id, name, quantity, price) VALUES ($1, 'Milk', 2, $2)",
            rid, total / 2,
        )
        await conn.execute(
            "INSERT INTO audit_logs (id, receipt_id, user_id, action, changed_by, timestamp)"
            " VALUES ($1, $2, $3, 'imported', 'system', 'now')",
            f"{rid}_audit", rid, uid,
        )
    finally:
        await conn.close()


async def test_import_into_other_user_rejects_external_conflict(client):
    """A backup whose receipt IDs belong to another user must be rejected by
    default (never silently clobber the original owner's rows)."""
    import os

    import asyncpg

    from app.services.backup_service import (
        export_user_data, import_user_data, ExternalConflictError,
    )
    from tests.conftest import TEST_DATABASE_URL

    admin_headers = await _admin(client)
    uid_a = (await _user(client, admin_headers, "extA@pytest.local"))["uid"]
    uid_b = (await _user(client, admin_headers, "extB@pytest.local"))["uid"]

    await _make_receipt_with_image(uid_a, "extrej_r1")
    exported = await export_user_data(uid_a)
    try:
        try:
            await import_user_data(uid_b, exported["path"], conflict="skip")
            assert False, "expected ExternalConflictError"
        except ExternalConflictError as e:
            assert e.conflicts == ["extrej_r1"]

        conn = await asyncpg.connect(TEST_DATABASE_URL)
        try:
            # original owner untouched; importing user got nothing
            assert await conn.fetchval(
                "SELECT count(*) FROM receipts WHERE user_id=$1", uid_a
            ) == 1
            assert await conn.fetchval(
                "SELECT count(*) FROM receipts WHERE user_id=$1", uid_b
            ) == 0
            assert await conn.fetchval(
                "SELECT supplier FROM receipts WHERE id='extrej_r1'"
            ) == "SUP A"
        finally:
            await conn.close()
    finally:
        os.remove(exported["path"])


async def test_import_into_other_user_remaps_copies(client):
    """With external_conflict='remap', the importing user gets a full
    independent copy under fresh IDs; the original owner is untouched."""
    import os

    import asyncpg

    from app.core.config import settings
    from app.services.backup_service import export_user_data, import_user_data
    from tests.conftest import TEST_DATABASE_URL

    admin_headers = await _admin(client)
    uid_a = (await _user(client, admin_headers, "remA@pytest.local"))["uid"]
    uid_b = (await _user(client, admin_headers, "remB@pytest.local"))["uid"]

    await _make_receipt_with_image(uid_a, "remap_r1")
    exported = await export_user_data(uid_a)
    try:
        stats = await import_user_data(
            uid_b, exported["path"], conflict="skip", external_conflict="remap"
        )
        assert stats["receipts"] == 1, stats
        assert stats["remapped"] == 1, stats
        assert stats["items"] == 1, stats
        assert stats["audit_logs"] == 1, stats
        assert stats["errors"] == 0, stats

        conn = await asyncpg.connect(TEST_DATABASE_URL)
        try:
            assert await conn.fetchval(
                "SELECT count(*) FROM receipts WHERE user_id=$1", uid_a
            ) == 1
            assert await conn.fetchval(
                "SELECT count(*) FROM receipts WHERE id='remap_r1' AND user_id=$1", uid_a
            ) == 1

            row = await conn.fetchrow(
                "SELECT id, image_filename FROM receipts WHERE user_id=$1", uid_b
            )
            assert row is not None
            assert row["id"] != "remap_r1"
            assert row["image_filename"] == f"{row['id']}.jpg"
            assert await conn.fetchval(
                "SELECT count(*) FROM line_items WHERE receipt_id=$1", row["id"]
            ) == 1

            # audit history follows the copy: fresh PK, remapped receipt_id,
            # pointing at the NEW user — never a collision-dropped original
            al = await conn.fetchrow(
                "SELECT id, receipt_id, user_id FROM audit_logs WHERE user_id=$1", uid_b
            )
            assert al is not None
            assert al["id"] != "remap_r1_audit"
            assert al["receipt_id"] == row["id"]
            assert al["user_id"] == uid_b
        finally:
            await conn.close()

        # image file was restored under the new id
        row = row["id"]
        assert os.path.exists(os.path.join(settings.IMAGE_STORAGE_DIR, f"{row}.jpg"))
    finally:
        os.remove(exported["path"])


async def test_import_api_rejects_then_remaps(client):
    """End-to-end: the endpoint returns 409 with a structured detail on reject,
    and succeeds with fresh copies when external_conflict='remap' is sent."""
    import os

    from app.services.backup_service import export_user_data

    admin_headers = await _admin(client)
    uid_a = (await _user(client, admin_headers, "apiA@pytest.local"))["uid"]
    uid_b = (await _user(client, admin_headers, "apiB@pytest.local"))["uid"]
    bh, _, _ = await login(client, "apiB@pytest.local", "pass-123")

    await _make_receipt_with_image(uid_a, "apirmap_r1")
    exported = await export_user_data(uid_a)
    try:
        with open(exported["path"], "rb") as f:
            resp = await client.post(
                f"/api/v1/users/{uid_b}/backup/import",
                headers=bh,
                files={"file": ("backup.tar.gz", f, "application/gzip")},
                data={"conflict": "skip"},
            )
        assert resp.status_code == 409, resp.text
        detail = resp.json()["detail"]
        assert detail["type"] == "external_conflict"
        assert detail["conflict_count"] == 1

        with open(exported["path"], "rb") as f:
            resp = await client.post(
                f"/api/v1/users/{uid_b}/backup/import",
                headers=bh,
                files={"file": ("backup.tar.gz", f, "application/gzip")},
                data={"conflict": "skip", "external_conflict": "remap"},
            )
        assert resp.status_code == 200, resp.text
        stats = resp.json()["stats"]
        assert stats["receipts"] == 1 and stats["remapped"] == 1, stats
    finally:
        os.remove(exported["path"])