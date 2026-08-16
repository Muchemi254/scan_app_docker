"""
Backup API endpoints.

POST   /users/{userId}/backup/export          Create + download backup
GET    /users/{userId}/backup/list             List backup history
GET    /users/{userId}/backup/quota            Per-user quota usage summary
GET    /users/{userId}/backup/download/{id}    Download a backup file
POST   /users/{userId}/backup/preview          Preview a backup file's contents
POST   /users/{userId}/backup/import           Import a backup with conflict options
DELETE /users/{userId}/backup/{id}             Delete a backup

Metadata lives in the `backups` Postgres table (shared server-side storage),
so the same account can list and download its backups from any device.
Creating a new export may prune this user's oldest backups to stay within
the admin-tunable per-user quota and retention limit.
"""

import json
import logging
import os
import shutil
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse, Response

from app.core.config import settings
from app.core.security import get_current_user_id, get_current_user_id_optional
from app.services.backup_service import (
    export_user_data,
    import_user_data,
    parse_backup,
    ExternalConflictError,
)
from app.services import ops_service
from app.services.app_settings_service import get_backup_limits
from app.services.database_service import DatabaseService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/users", tags=["backup"])


def _verify_access(user_id: str, current_user_id: str):
    if user_id != current_user_id:
        raise HTTPException(status_code=403, detail="Access denied")


def _check_disk_space(filepath: str) -> None:
    """Refuse to write a backup when the server is nearly out of disk."""
    try:
        min_free = settings.BACKUP_MIN_FREE_BYTES
        if min_free > 0:
            usage = shutil.disk_usage(os.path.dirname(filepath))
            if usage.free < min_free:
                raise HTTPException(
                    status_code=status.HTTP_507_INSUFFICIENT_STORAGE,
                    detail=(
                        "Server is low on storage — delete some backups or "
                        "contact an administrator before creating another."
                    ),
                )
    except HTTPException:
        raise
    except Exception:
        logger.warning("Could not check free disk space", exc_info=True)


async def _remove_backup(user_id: str, backup_id: str) -> None:
    """Delete the archive file + its metadata row (missing file is fine)."""
    path = os.path.join(settings.BACKUP_STORAGE_DIR, f"{backup_id}.tar.gz")
    try:
        os.remove(path)
    except OSError:
        pass
    await DatabaseService.delete_backup_record(user_id, backup_id)


async def _prune_backups(user_id: str) -> None:
    """
    Auto-prune the user's oldest backups until both limits hold:
      * at most `max_backups_per_user` archives, and
      * at most `max_backup_bytes_per_user` total bytes.
    Only rows with actual files are counted for the byte quota.
    """
    limits = await get_backup_limits()
    max_count = int(limits["max_backups_per_user"])
    max_bytes = int(limits["max_backup_bytes_per_user"])

    # 1. Retention — keep the newest N.
    if max_count > 0:
        newest = await DatabaseService.list_backups(user_id)  # DESC
        for row in newest[max_count:]:
            await _remove_backup(user_id, row["id"])

    # 2. Byte quota — delete oldest until the total fits.
    if max_bytes > 0:
        oldest = await DatabaseService.list_oldest_backups(user_id)  # ASC
        total = 0
        for row in oldest:
            fpath = os.path.join(settings.BACKUP_STORAGE_DIR, f"{row['id']}.tar.gz")
            if os.path.exists(fpath):
                try:
                    total += int(os.path.getsize(fpath))
                except OSError:
                    pass
        i = 0
        while total > max_bytes and i < len(oldest):
            row = oldest[i]
            fpath = os.path.join(settings.BACKUP_STORAGE_DIR, f"{row['id']}.tar.gz")
            size = 0
            try:
                size = int(os.path.getsize(fpath))
            except OSError:
                pass
            await _remove_backup(user_id, row["id"])
            total -= size
            i += 1


# ── Export ───────────────────────────────────────────────────────────────────

@router.post("/{userId}/backup/export")
async def create_backup(
    userId: str,
    current_user_id: str = Depends(get_current_user_id),
):
    """Create a backup of all user data + images and stream as download."""
    _verify_access(userId, current_user_id)

    os.makedirs(settings.BACKUP_STORAGE_DIR, exist_ok=True)
    _check_disk_space(settings.BACKUP_STORAGE_DIR)

    try:
        result = await export_user_data(userId)
    except Exception as e:
        logger.error("Backup export failed: %s", e)
        raise HTTPException(status_code=500, detail=f"Backup failed: {e}")

    filepath = result["path"]
    backup_id = result["id"]
    filename = f"scanapp_backup_{userId[:8]}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.tar.gz"

    await DatabaseService.create_backup_record(
        userId, backup_id, filename, result["size_bytes"], datetime.now(timezone.utc),
        image_count=result.get("image_count", 0),
        missing_images=result.get("missing_images", 0),
    )

    if result.get("missing_images", 0) > 0:
        logger.warning(
            "Backup %s for user %s saved WITHOUT images for %d receipt(s) "
            "(files missing from storage) — total %d images packed",
            backup_id, userId[:12], result["missing_images"],
            result.get("image_count", 0),
        )

    # Enforce the per-user quota/retention — prunes this user's oldest archives.
    await _prune_backups(userId)

    return FileResponse(
        path=filepath,
        media_type="application/gzip",
        filename=filename,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )


# ── List ─────────────────────────────────────────────────────────────────────

@router.get("/{userId}/backup/list")
async def list_backups(
    userId: str,
    current_user_id: str = Depends(get_current_user_id),
):
    """List available backups for this user (from any device)."""
    _verify_access(userId, current_user_id)
    rows = await DatabaseService.list_backups(userId)
    for row in rows:
        backup_path = os.path.join(settings.BACKUP_STORAGE_DIR, f"{row['id']}.tar.gz")
        row["available"] = os.path.exists(backup_path)
    return rows


# ── Quota ────────────────────────────────────────────────────────────────────

@router.get("/{userId}/backup/quota")
async def backup_quota(
    userId: str,
    current_user_id: str = Depends(get_current_user_id),
):
    """Per-user backup quota usage, for the Settings UI to report space left."""
    _verify_access(userId, current_user_id)
    limits = await get_backup_limits()
    total = 0
    count = 0
    for row in await DatabaseService.list_backups(userId):
        fpath = os.path.join(settings.BACKUP_STORAGE_DIR, f"{row['id']}.tar.gz")
        if os.path.exists(fpath):
            count += 1
            try:
                total += int(os.path.getsize(fpath))
            except OSError:
                pass
    return {
        "used_bytes": total,
        "limit_bytes": int(limits["max_backup_bytes_per_user"]),
        "count": count,
        "max_count": int(limits["max_backups_per_user"]),
    }


# ── Download ─────────────────────────────────────────────────────────────────

@router.get("/{userId}/backup/download/{backupId}")
async def download_backup(
    userId: str,
    backupId: str,
    token: Optional[str] = Query(None),
    current_user_id: Optional[str] = Depends(get_current_user_id_optional),
):
    """
    Download a previously created backup.

    Auth: a `?token=` query string (for headerless browser links) takes
    precedence; otherwise the `Authorization` header is required.
    """
    if token:
        if settings.AUTH_MODE == "local":
            from app.services.auth_service import decode_access_token
            try:
                if decode_access_token(token) != userId:
                    raise HTTPException(status_code=403, detail="Access denied")
            except ValueError:
                raise HTTPException(status_code=401, detail="Invalid token")
        else:
            import firebase_admin
            from firebase_admin import auth as firebase_auth
            try:
                decoded = firebase_auth.verify_id_token(token)
                if decoded.get("uid") != userId:
                    raise HTTPException(status_code=403, detail="Access denied")
            except Exception:
                raise HTTPException(status_code=401, detail="Invalid token")
    elif current_user_id is not None:
        _verify_access(userId, current_user_id)
    else:
        raise HTTPException(status_code=401, detail="Not authenticated")

    # Let RLS adopt the target tenant for the DB lookup below.
    from app.core.database import set_current_user_id
    set_current_user_id(userId)

    row = await DatabaseService.get_backup(userId, backupId)
    if not row:
        raise HTTPException(status_code=404, detail="Backup not found")

    backup_path = os.path.join(settings.BACKUP_STORAGE_DIR, f"{backupId}.tar.gz")
    if not os.path.exists(backup_path):
        raise HTTPException(status_code=404, detail="Backup file no longer available")

    return FileResponse(
        path=backup_path,
        media_type="application/gzip",
        filename=row["filename"],
        headers={
            "Content-Disposition": f'attachment; filename="{row["filename"]}"',
        },
    )


# ── Preview ──────────────────────────────────────────────────────────────────

@router.post("/{userId}/backup/preview")
async def preview_backup(
    userId: str,
    file: UploadFile = File(...),
    current_user_id: str = Depends(get_current_user_id),
):
    """Preview a backup file before importing — shows receipt list."""
    _verify_access(userId, current_user_id)

    tmp_path = os.path.join(settings.BACKUP_STORAGE_DIR, f"_preview_{userId[:8]}.tar.gz")
    try:
        with open(tmp_path, "wb") as dst:
            shutil.copyfileobj(file.file, dst, 65536)

        preview = parse_backup(tmp_path)

        # How many of these receipt IDs already belong to a *different* user?
        # Surfaced so the UI can ask Reject-vs-Remap before importing.
        preview["external_conflict_count"] = 0
        rids = [r["id"] for r in preview.get("receipts", [])]
        if rids:
            from app.core.database import get_pool

            pool = await get_pool()
            async with pool.acquire() as conn:
                preview["external_conflict_count"] = await conn.fetchval(
                    "SELECT count(*) FROM receipts WHERE id = ANY($1) AND user_id <> $2",
                    rids, userId,
                )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid backup file: {e}")
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass

    return preview


# ── Import ───────────────────────────────────────────────────────────────────

@router.post("/{userId}/backup/import")
async def import_backup(
    userId: str,
    file: UploadFile = File(...),
    conflict: str = Form("skip"),
    selected_ids: Optional[str] = Form(None),
    external_conflict: str = Form("reject"),
    op_id: Optional[str] = Form(None),
    current_user_id: str = Depends(get_current_user_id),
):
    """
    Import a backup file.

    conflict: 'overwrite' | 'skip' | 'merge'
    selected_ids: JSON array of receipt IDs to import (null = import all)
    external_conflict: 'reject' | 'remap' — how to handle receipts whose IDs
        already belong to a *different* user. 'reject' (default) fails with
        409; 'remap' imports them as copies with fresh IDs.
    op_id: client-generated operation id for polling /ops/{op_id} progress.
    """
    _verify_access(userId, current_user_id)

    if conflict not in ("overwrite", "skip", "merge"):
        raise HTTPException(status_code=400, detail="conflict must be: overwrite, skip, or merge")
    if external_conflict not in ("reject", "remap"):
        raise HTTPException(status_code=400, detail="external_conflict must be: reject or remap")

    ids = None
    if selected_ids:
        try:
            ids = json.loads(selected_ids)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="selected_ids must be valid JSON array")

    tmp_path = os.path.join(settings.BACKUP_STORAGE_DIR, f"_import_{userId[:8]}.tar.gz")
    op_ref = op_id or f"import_{userId[:8]}_{uuid.uuid4().hex[:8]}"
    await ops_service.start_op(
        op_ref, "import", owner=userId, message="Upload complete — reading backup…"
    )
    try:
        with open(tmp_path, "wb") as dst:
            shutil.copyfileobj(file.file, dst, 65536)

        stats = await import_user_data(
            userId, tmp_path, conflict=conflict, selected_ids=ids,
            external_conflict=external_conflict, op_id=op_ref,
        )
        await ops_service.update_op(
            op_ref, stage="done", message="Import complete", status="completed", result=stats
        )
    except ExternalConflictError as e:
        await ops_service.update_op(
            op_ref, status="failed", message=str(e)
        )
        raise HTTPException(
            status_code=409,
            detail={
                "type": "external_conflict",
                "conflict_count": len(e.conflicts),
                "message": str(e),
                "conflicts": e.conflicts[:200],
            },
        )
    except Exception as e:
        logger.error("Import failed: %s", e)
        await ops_service.update_op(op_ref, status="failed", message=f"Import failed: {e}")
        raise HTTPException(status_code=500, detail=f"Import failed: {e}")
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass

    return {"status": "ok", "op_id": op_ref, "stats": stats}


# ── Delete ───────────────────────────────────────────────────────────────────

@router.delete("/{userId}/backup/{backupId}", status_code=204)
async def delete_backup(
    userId: str,
    backupId: str,
    current_user_id: str = Depends(get_current_user_id),
):
    """Delete a backup file."""
    _verify_access(userId, current_user_id)

    entry = await DatabaseService.get_backup(userId, backupId)
    if entry:
        await _remove_backup(userId, backupId)

    return Response(status_code=status.HTTP_204_NO_CONTENT)