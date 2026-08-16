"""
Background data cleanup for deleted users.

Deleting a user must remove their data too, but must NOT do the heavy work
inline in the DELETE request. So the admin delete endpoint only removes the
`users` row (fast, also revokes auth immediately; Postgres FK CASCADE cleans
their `backups` and `user_preferences` rows). Everything else the user owns —
receipts (+ line items), tasks, scan sessions (+ items), review batches
(+ items), audit logs, scan errors, per-model AI settings, and the on-disk
files (receipt images, backup tarballs, `_scan_*`/`_batch_*` temp dirs) —
is removed here, in the background.

Two entry points, both idempotent and safe to schedule:

  * ``force_user_cleanup(user_id)``       purge one (just-deleted) user now.
  * ``cleanup_orphaned_data()``           full sweep: purge any rows still
                                          orphaned by users deleted before this
                                          feature existed, plus file-level
                                          garbage (backups/images with no
                                          referencing row, stale temp dirs).

File sweeps apply a minimum-age grace so files of live users that are being
written right now are never mistaken for orphans.
"""

import glob
import logging
import os
import shutil
import time

from app.core.config import settings
from app.services import ops_service

logger = logging.getLogger(__name__)

# Tables keyed by user_id with NO FK to users (so their rows survive a user
# delete and must be cleaned by us). `backups` + `user_preferences` cascade
# via FK and are included here just as a safety net.
_USER_TABLES = (
    "receipts",
    "audit_logs",
    "tasks",
    "review_batches",
    "scan_errors",
    "scan_sessions",
    "backups",
    "user_ai_settings",
)

_TEMP_DIR_PREFIXES = ("_scan_", "_batch_", "_import_", "_preview_")


def _path_age_seconds(path: str) -> float:
    try:
        return time.time() - os.path.getmtime(path)
    except OSError:
        return float("inf")


def _unlink(path: str) -> bool:
    try:
        os.remove(path)
        return True
    except FileNotFoundError:
        return False
    except OSError as e:
        logger.warning("Failed to remove %s: %s", path, e)
        return False


def _remove_receipt_images(receipt_ids: list[str]) -> int:
    """Delete <receipt_id>.jpg + <receipt_id>_thumb.jpg for each id."""
    removed = 0
    for rid in receipt_ids:
        for name in (f"{rid}.jpg", f"{rid}_thumb.jpg"):
            removed += _unlink(os.path.join(settings.IMAGE_STORAGE_DIR, name))
    return removed


def _remove_backup_files(backup_ids: list[str]) -> int:
    removed = 0
    for bid in backup_ids:
        removed += _unlink(os.path.join(settings.BACKUP_STORAGE_DIR, f"{bid}.tar.gz"))
    return removed


def _remove_temp_dirs(session_ids: list[str], task_ids: list[str]) -> int:
    removed = 0
    for sid in session_ids:
        try:
            shutil.rmtree(
                os.path.join(settings.IMAGE_STORAGE_DIR, f"_scan_{sid}"),
                ignore_errors=True,
            )
            removed += 1
        except OSError:
            pass
    for tid in task_ids:
        try:
            shutil.rmtree(
                os.path.join(settings.IMAGE_STORAGE_DIR, f"_batch_{tid}"),
                ignore_errors=True,
            )
            removed += 1
        except OSError:
            pass
    return removed


async def _fetch(sql: str, *args):
    from app.core.database import get_pool
    pool = await get_pool()
    async with pool.acquire() as conn:
        return await conn.fetch(sql, *args)


async def purge_user_data(user_id: str, op_id: str = None) -> dict:
    """Delete every row and on-disk file owned by ``user_id``."""
    from app.core.database import get_pool

    receipts = await _fetch("SELECT id FROM receipts WHERE user_id = $1", user_id)
    tasks = await _fetch("SELECT id FROM tasks WHERE user_id = $1", user_id)
    sessions = await _fetch("SELECT id FROM scan_sessions WHERE user_id = $1", user_id)
    backups = await _fetch("SELECT id FROM backups WHERE user_id = $1", user_id)
    total_rows = len(receipts) + len(tasks) + len(sessions) + len(backups)

    if op_id:
        await ops_service.update_op(
            op_id, stage="purging", message="Removing account data…",
            total={"rows": total_rows, "images": len(receipts) * 2},
        )

    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            deleted_rows = 0
            for table in _USER_TABLES:
                res = await conn.execute(
                    f"DELETE FROM {table} WHERE user_id = $1", user_id
                )
                deleted_rows += int(res.split()[-1])
                if op_id and deleted_rows:
                    await ops_service.update_op(
                        op_id, stage="purging",
                        counts={"rows": deleted_rows},
                        message=f"Removing account data… {deleted_rows} rows",
                    )

    removed_images = _remove_receipt_images([str(r["id"]) for r in receipts])
    removed_backups = _remove_backup_files([str(r["id"]) for r in backups])
    removed_dirs = _remove_temp_dirs(
        [str(r["id"]) for r in sessions], [str(r["id"]) for r in tasks]
    )
    if op_id:
        await ops_service.update_op(
            op_id, stage="cleanup", message="Removing files…",
            counts={"images": removed_images, "backups": removed_backups},
        )

    stats = {
        "user_id": user_id,
        "rows_deleted": deleted_rows,
        "removed_images": removed_images,
        "removed_backups": removed_backups,
        "removed_temp_dirs": removed_dirs,
    }
    logger.info("Purged data for deleted user %s: %s", user_id, stats)
    return stats


# ── Orphan file sweeps (age-guarded to protect in-flight writes) ──────────────


async def _sweep_orphan_backup_files() -> int:
    """Delete backup tarballs in BACKUP_STORAGE_DIR with no `backups` row."""
    referenced = {str(r["id"]) for r in await _fetch("SELECT id FROM backups")}
    age_guard = settings.ORPHANED_FILE_MIN_AGE_SECONDS
    removed = 0
    for path in glob.glob(os.path.join(settings.BACKUP_STORAGE_DIR, "*.tar.gz")):
        bid = os.path.basename(path)[: -len(".tar.gz")]
        if bid in referenced:
            continue
        if _path_age_seconds(path) < age_guard:
            continue
        removed += _unlink(path)
    return removed


async def _sweep_orphan_image_files() -> int:
    """Delete top-level, orphan receipt image files in IMAGE_STORAGE_DIR.

    Only `<something>.jpg` / `<something>_thumb.jpg` directly in the storage
    dir (per-receipt images) are considered; filename-prefixed temp dirs are
    handled separately. Files referenced by any live receipt or session item
    are never touched.
    """
    referenced = set()
    for r in await _fetch(
        "SELECT image_filename FROM receipts WHERE image_filename IS NOT NULL"
    ):
        name = r["image_filename"]
        referenced.add(name)
        if name.endswith(".jpg"):
            referenced.add(name[: -len(".jpg")] + "_thumb.jpg")
    for r in await _fetch(
        "SELECT image_filename FROM scan_session_items WHERE image_filename IS NOT NULL"
    ):
        referenced.add(r["image_filename"])

    age_guard = settings.ORPHANED_FILE_MIN_AGE_SECONDS
    removed = 0
    entry: str
    for entry in os.listdir(settings.IMAGE_STORAGE_DIR):
        path = os.path.join(settings.IMAGE_STORAGE_DIR, entry)
        if not os.path.isfile(path):
            continue  # subdirs (temp dirs) handled by _sweep_stale_temp_dirs
        if not (entry.endswith(".jpg") or entry.endswith("_thumb.jpg")):
            continue
        if entry in referenced:
            continue
        if _path_age_seconds(path) < age_guard:
            continue
        removed += _unlink(path)
    return removed


async def _sweep_stale_temp_dirs() -> int:
    """Remove abandoned `_scan_*` / `_batch_*` / `_import_*` / `_preview_*` dirs."""
    removed = 0
    try:
        entries = os.listdir(settings.IMAGE_STORAGE_DIR)
    except OSError:
        return 0
    for entry in entries:
        if not entry.startswith(_TEMP_DIR_PREFIXES):
            continue
        path = os.path.join(settings.IMAGE_STORAGE_DIR, entry)
        if not os.path.isdir(path):
            continue
        if _path_age_seconds(path) < settings.TEMP_DIR_MAX_AGE_SECONDS:
            continue
        try:
            shutil.rmtree(path, ignore_errors=True)
            removed += 1
        except OSError as e:
            logger.warning("Failed to remove temp dir %s: %s", path, e)
    return removed


# ── Public entry points ───────────────────────────────────────────────────────


async def force_user_cleanup(user_id: str, backup_ids: list[str] | None = None,
                             op_id: str = None) -> dict:
    """Purge one just-deleted user's data + file garbage. Fire-and-forget.

    ``backup_ids`` are the user's backup tarball ids captured *before* the
    user row was deleted (the FK CASCADE removed the `backups` rows, so they
    can't be re-discovered from the DB). Passing them lets us delete those
    files immediately instead of waiting out the orphan-file age guard.
    ``op_id`` (optional) enables progress polling under /ops/{op_id}.
    """
    try:
        stats = await purge_user_data(user_id, op_id=op_id)
    except Exception as e:
        stats = {"user_id": user_id, "error": str(e)}
        logger.warning("force_user_cleanup(%s) failed: %s", user_id, e)
        if op_id:
            await ops_service.update_op(op_id, status="failed", message=f"Cleanup failed: {e}")
    direct_backups = _remove_backup_files(list(backup_ids or []))
    stats["removed_backups"] = stats.get("removed_backups", 0) + direct_backups
    try:
        stats["orphan_backup_files_removed"] = await _sweep_orphan_backup_files()
    except Exception as e:
        logger.warning("backup file sweep failed: %s", e)
    try:
        stats["stale_temp_dirs_removed"] = await _sweep_stale_temp_dirs()
    except Exception as e:
        logger.warning("temp dir sweep failed: %s", e)
    if op_id:
        await ops_service.update_op(
            op_id, stage="done", message="Deletion complete",
            status="completed", result=stats,
        )
    return stats


async def cleanup_orphaned_data() -> dict:
    """Full sweep — purge any deleted users' leftover data and file garbage.

    Returns a stats dict (all zero when there is nothing to do).
    """
    stats = {
        "users_purged": 0,
        "rows_deleted": 0,
        "removed_images": 0,
        "removed_backups": 0,
        "removed_temp_dirs": 0,
        "orphan_backup_files_removed": 0,
        "orphan_image_files_removed": 0,
        "stale_temp_dirs_removed": 0,
    }

    orphan_users = await _fetch(
        """
        SELECT user_id, COUNT(*) AS n FROM (
            SELECT user_id FROM receipts
            UNION ALL SELECT user_id FROM tasks
            UNION ALL SELECT user_id FROM scan_sessions
            UNION ALL SELECT user_id FROM review_batches
            UNION ALL SELECT user_id FROM audit_logs
            UNION ALL SELECT user_id FROM scan_errors
            UNION ALL SELECT user_id FROM user_ai_settings
        ) t
        WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.uid = t.user_id)
        GROUP BY user_id
        """
    )
    for row in orphan_users:
        try:
            purged = await purge_user_data(str(row["user_id"]))
            stats["users_purged"] += 1
            stats["rows_deleted"] += purged["rows_deleted"]
            stats["removed_images"] += purged["removed_images"]
            stats["removed_backups"] += purged["removed_backups"]
            stats["removed_temp_dirs"] += purged["removed_temp_dirs"]
        except Exception as e:
            logger.warning("orphan purge for %s failed: %s", row["user_id"], e)

    stats["orphan_backup_files_removed"] = await _sweep_orphan_backup_files()
    stats["orphan_image_files_removed"] = await _sweep_orphan_image_files()
    stats["stale_temp_dirs_removed"] = await _sweep_stale_temp_dirs()
    return stats