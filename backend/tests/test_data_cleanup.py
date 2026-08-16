"""
Tests for the deleted-user data cleanup (background, not inline).

Covers:
  - purge_user_data removes a user's rows across all tables AND their
    on-disk files (receipt images, backup tarballs, _scan_/_batch_ temp dirs)
  - cleanup_orphaned_data purges rows/files left by already-deleted users
    and sweeps unreferenced backup/image files (age-guarded)
  - live users' referenced files are never removed
"""

import os
import time
import uuid

import pytest_asyncio

from tests.conftest import TEST_DATABASE_URL
from tests.helpers import ADMIN_EMAIL, ADMIN_PASSWORD, create_user_via_admin, login

from app.core.config import settings


# ── local helpers ─────────────────────────────────────────────────────────────


async def _conn():
    import asyncpg
    return await asyncpg.connect(TEST_DATABASE_URL)


def _reset_storage_dirs():
    for d in (settings.IMAGE_STORAGE_DIR, settings.BACKUP_STORAGE_DIR):
        os.makedirs(d, exist_ok=True)
        for entry in os.listdir(d):
            path = os.path.join(d, entry)
            try:
                os.remove(path) if os.path.isfile(path) else __import__("shutil").rmtree(path)
            except OSError:
                pass


def _age(path, seconds=3600):
    t = time.time() - seconds
    os.utime(path, (t, t))


def _receipt_image(pk):
    return os.path.join(settings.IMAGE_STORAGE_DIR, f"{pk}.jpg")


def _session_dir(sid):
    return os.path.join(settings.IMAGE_STORAGE_DIR, f"_scan_{sid}")


def _task_dir(tid):
    return os.path.join(settings.IMAGE_STORAGE_DIR, f"_batch_{tid}")


def _backup_file(rid):
    return os.path.join(settings.BACKUP_STORAGE_DIR, f"{rid}.tar.gz")


async def _seed_user_data(uid, *, with_review=True, with_errors=True, with_audit=True):
    """Insert a plausible data set for `uid`; returns created ids + file paths."""
    ids = [uuid.uuid4().hex[:8] for _ in range(4)]
    rid, tid, sid, bid = ids
    c = await _conn()

    await c.execute(
        "INSERT INTO receipts (id, user_id, supplier, receipt_date, image_filename) "
        "VALUES ($1, $2, 'ACME', '2026-08-01', $3)",
        rid, uid, f"{rid}.jpg",
    )
    await c.execute(
        "INSERT INTO tasks (id, user_id, task_type, batch_title) "
        "VALUES ($1, $2, 'batch', 'B')",
        tid, uid,
    )
    await c.execute(
        "INSERT INTO scan_sessions (id, user_id, title) VALUES ($1, $2, 'S')",
        sid, uid,
    )
    await c.execute(
        "INSERT INTO scan_session_items (id, session_id, user_id, item_index) "
        "VALUES ($1, $2, $3, 0)",
        uuid.uuid4().hex[:8], sid, uid,
    )
    await c.execute(
        "INSERT INTO backups (id, user_id, filename, size_bytes) "
        "VALUES ($1, $2, $3, 100)",
        bid, uid, f"{bid}.tar.gz",
    )
    await c.execute(
        "INSERT INTO user_ai_settings (user_id) VALUES ($1)", uid,
    )
    if with_review:
        await c.execute(
            "INSERT INTO review_batches (id, user_id, name) VALUES ($1, $2, 'R')",
            uuid.uuid4().hex[:8], uid,
        )
    if with_errors:
        await c.execute(
            "INSERT INTO scan_errors (id, user_id, code, message) VALUES ($1, $2, 'E', 'm')",
            uuid.uuid4().hex[:8], uid,
        )
    if with_audit:
        await c.execute(
            "INSERT INTO audit_logs (id, receipt_id, user_id, action, changed_by) "
            "VALUES ($1, $2, $3, 'create', 'admin')",
            uuid.uuid4().hex[:8], rid, uid,
        )

    # on-disk artifacts
    for p in (_receipt_image(rid), f"{_receipt_image(rid)[:-4]}_thumb.jpg"):
        open(p, "wb").write(b"jpeg")
    os.makedirs(_session_dir(sid), exist_ok=True)
    os.makedirs(_task_dir(tid), exist_ok=True)
    open(_backup_file(bid), "wb").write(b"tar")

    await c.close()
    return {"rid": rid, "tid": tid, "sid": sid, "bid": bid}


async def _count(table, uid):
    c = await _conn()
    try:
        n = await c.fetchval(f"SELECT COUNT(*) FROM {table} WHERE user_id = $1", uid)
    finally:
        await c.close()
    return n


async def _admin_headers(client):
    headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    return headers


# ── fixtures ──────────────────────────────────────────────────────────────────


@pytest_asyncio.fixture(autouse=True)
def _isolated_storage():
    _reset_storage_dirs()
    yield
    _reset_storage_dirs()


async def _make_user(client, email):
    admin = await _admin_headers(client)
    user = await create_user_via_admin(client, admin, email, "pass-123")
    return user["uid"]


# ── tests ─────────────────────────────────────────────────────────────────────


async def test_purge_user_data_removes_rows_files_and_dirs(client):
    uid = await _make_user(client, "purge1@pytest.local")
    seeded = await _seed_user_data(uid)

    from app.services.data_cleanup_service import purge_user_data
    stats = await purge_user_data(uid)

    assert stats["rows_deleted"] >= 6  # receipts+tasks+session+errors+batch+settings+backups (audit_logs cascades with receipts)
    for table in ("receipts", "tasks", "scan_sessions", "scan_session_items",
                  "audit_logs", "scan_errors", "review_batches",
                  "user_ai_settings", "backups"):
        assert await _count(table, uid) == 0, f"{table} still has rows"

    assert not os.path.exists(_receipt_image(seeded["rid"]))
    assert not os.path.exists(_receipt_image(seeded["rid"])[:-4] + "_thumb.jpg")
    assert not os.path.exists(_backup_file(seeded["bid"]))
    assert not os.path.exists(_session_dir(seeded["sid"]))
    assert not os.path.exists(_task_dir(seeded["tid"]))
    assert stats["removed_images"] == 2
    assert stats["removed_backups"] == 1
    assert stats["removed_temp_dirs"] == 2


async def test_cleanup_orphaned_data_purges_deleted_users_data(client):
    uid = await _make_user(client, "orphan1@pytest.local")
    seeded = await _seed_user_data(uid)
    # age the backup tarball so the orphan-file sweep will take it
    _age(_backup_file(seeded["bid"]))

    # Simulate the admin delete: only the users row is removed (fast path).
    # FK CASCADE removes backups + user_preferences rows; everything else
    # (receipts, tasks, sessions, …) has no FK and must survive for the sweep.
    c = await _conn()
    try:
        await c.execute("DELETE FROM users WHERE uid = $1", uid)
    finally:
        await c.close()
    assert await _count("receipts", uid) == 1  # still orphaned
    assert os.path.exists(_receipt_image(seeded["rid"]))
    assert os.path.exists(_backup_file(seeded["bid"]))  # row cascaded, file left

    from app.services.data_cleanup_service import cleanup_orphaned_data
    stats = await cleanup_orphaned_data()

    assert stats["users_purged"] == 1
    for table in ("receipts", "tasks", "scan_sessions", "scan_session_items",
                  "audit_logs", "scan_errors", "review_batches",
                  "user_ai_settings", "backups"):
        assert await _count(table, uid) == 0, f"{table} still has rows"
    assert stats["orphan_backup_files_removed"] == 1
    assert not os.path.exists(_receipt_image(seeded["rid"]))
    assert not os.path.exists(_backup_file(seeded["bid"]))
    assert not os.path.exists(_session_dir(seeded["sid"]))
    assert not os.path.exists(_task_dir(seeded["tid"]))


async def test_sweep_keeps_live_users_files_and_removes_only_orphans(client):
    uid = await _make_user(client, "live1@pytest.local")
    seeded = await _seed_user_data(uid, with_review=False, with_errors=False, with_audit=False)

    # unreferenced garbage on disk (aged past the grace period)
    orphan_img = os.path.join(settings.IMAGE_STORAGE_DIR, "deadbeef.jpg")
    open(orphan_img, "wb").write(b"jpeg"); _age(orphan_img)
    orphan_thumb = os.path.join(settings.IMAGE_STORAGE_DIR, "deadbeef_thumb.jpg")
    open(orphan_thumb, "wb").write(b"jpeg"); _age(orphan_thumb)
    orphan_bk = os.path.join(settings.BACKUP_STORAGE_DIR, "cafebabe.tar.gz")
    open(orphan_bk, "wb").write(b"tar"); _age(orphan_bk)

    from app.services.data_cleanup_service import cleanup_orphaned_data
    stats = await cleanup_orphaned_data()

    # live user untouched
    assert stats["users_purged"] == 0
    assert await _count("receipts", uid) == 1
    assert await _count("backups", uid) == 1
    assert os.path.exists(_receipt_image(seeded["rid"]))
    assert os.path.exists(_backup_file(seeded["bid"]))
    # only the unreferenced garbage went away
    assert stats["orphan_image_files_removed"] == 2
    assert stats["orphan_backup_files_removed"] == 1
    assert not os.path.exists(orphan_img)
    assert not os.path.exists(orphan_thumb)
    assert not os.path.exists(orphan_bk)


async def test_force_user_cleanup_purges_even_without_orphan_sweep(client):
    """force_user_cleanup (fired right after a delete) removes everything
    for that user, including a FRESH backup tarball whose row was already
    cascade-deleted (ids are passed in, so no age guard delays it)."""
    uid = await _make_user(client, "force1@pytest.local")
    seeded = await _seed_user_data(uid)
    _age(_backup_file(seeded["bid"]), seconds=15)  # still far under the age guard

    c = await _conn()
    try:
        await c.execute("DELETE FROM users WHERE uid = $1", uid)
    finally:
        await c.close()

    from app.services.data_cleanup_service import force_user_cleanup
    stats = await force_user_cleanup(uid, backup_ids=[seeded["bid"]])

    for table in ("receipts", "tasks", "scan_sessions", "scan_session_items",
                  "audit_logs", "scan_errors", "user_ai_settings"):
        assert await _count(table, uid) == 0, f"{table} still has rows"
    assert not os.path.exists(_receipt_image(seeded["rid"]))
    assert not os.path.exists(_backup_file(seeded["bid"]))
    assert not os.path.exists(_session_dir(seeded["sid"]))
    assert stats["removed_backups"] >= 1  # direct removal via passed-in ids