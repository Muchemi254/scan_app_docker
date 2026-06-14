"""
Backup API endpoints.

POST   /users/{userId}/backup/export          Create + download backup
GET    /users/{userId}/backup/list             List backup history
GET    /users/{userId}/backup/download/{id}    Download a backup file
POST   /users/{userId}/backup/preview          Preview a backup file's contents
POST   /users/{userId}/backup/import           Import a backup with conflict options
DELETE /users/{userId}/backup/{id}             Delete a backup
"""

import json
import logging
import os
import shutil
from datetime import datetime, timezone
from typing import Optional, List

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse, Response

from app.core.security import get_current_user_id
import firebase_admin
from firebase_admin import auth as firebase_auth
from app.services.backup_service import export_user_data, import_user_data, parse_backup
from app.core.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/users", tags=["backup"])

BACKUP_DB = os.path.join(settings.BACKUP_STORAGE_DIR, "backup_history.json")


def _verify_access(user_id: str, current_user_id: str):
    if user_id != current_user_id:
        raise HTTPException(status_code=403, detail="Access denied")


def _load_history() -> List[dict]:
    try:
        with open(BACKUP_DB, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return []


def _save_history(history: List[dict]):
    os.makedirs(os.path.dirname(BACKUP_DB), exist_ok=True)
    with open(BACKUP_DB, "w") as f:
        json.dump(history, f, indent=2, default=str)


# ── Export ───────────────────────────────────────────────────────────────────

@router.post("/{userId}/backup/export")
async def create_backup(
    userId: str,
    current_user_id: str = Depends(get_current_user_id),
):
    """Create a backup of all user data + images and stream as download."""
    _verify_access(userId, current_user_id)

    try:
        result = await export_user_data(userId)
    except Exception as e:
        logger.error("Backup export failed: %s", e)
        raise HTTPException(status_code=500, detail=f"Backup failed: {e}")

    filepath = result["path"]
    backup_id = result["id"]
    timestamp = datetime.now(timezone.utc).isoformat()
    filename = f"scanapp_backup_{userId[:8]}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.tar.gz"

    # Record in history
    history = _load_history()
    history.insert(0, {
        "id": backup_id,
        "user_id": userId,
        "filename": filename,
        "created_at": timestamp,
        "size_bytes": result["size_bytes"],
        "size_kb": result["size_bytes"] // 1024,
    })
    _save_history(history)

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
    """List available backups for this user."""
    _verify_access(userId, current_user_id)

    history = _load_history()
    user_backups = [h for h in history if h["user_id"] == userId]

    for h in user_backups:
        backup_path = os.path.join(settings.BACKUP_STORAGE_DIR, f"{h['id']}.tar.gz")
        h["available"] = os.path.exists(backup_path)

    return user_backups


# ── Download ─────────────────────────────────────────────────────────────────

@router.get("/{userId}/backup/download/{backupId}")
async def download_backup(
    userId: str,
    backupId: str,
    token: Optional[str] = Query(None),
    current_user_id: str = Depends(get_current_user_id),
):
    """Download a previously created backup. Accepts ?token= for direct browser downloads."""
    if token:
        try:
            decoded = firebase_auth.verify_id_token(token)
            if decoded.get("uid") != userId:
                raise HTTPException(status_code=403, detail="Access denied")
        except Exception:
            raise HTTPException(status_code=401, detail="Invalid token")
    else:
        _verify_access(userId, current_user_id)

    history = _load_history()
    entry = next(
        (h for h in history if h["id"] == backupId and h["user_id"] == userId),
        None,
    )
    if not entry:
        raise HTTPException(status_code=404, detail="Backup not found")

    backup_path = os.path.join(settings.BACKUP_STORAGE_DIR, f"{backupId}.tar.gz")
    if not os.path.exists(backup_path):
        raise HTTPException(status_code=404, detail="Backup file no longer available")

    return FileResponse(
        path=backup_path,
        media_type="application/gzip",
        filename=entry["filename"],
        headers={
            "Content-Disposition": f'attachment; filename="{entry["filename"]}"',
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
    current_user_id: str = Depends(get_current_user_id),
):
    """
    Import a backup file.

    conflict: 'overwrite' | 'skip' | 'merge'
    selected_ids: JSON array of receipt IDs to import (null = import all)
    """
    _verify_access(userId, current_user_id)

    if conflict not in ("overwrite", "skip", "merge"):
        raise HTTPException(status_code=400, detail="conflict must be: overwrite, skip, or merge")

    ids = None
    if selected_ids:
        try:
            ids = json.loads(selected_ids)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="selected_ids must be valid JSON array")

    tmp_path = os.path.join(settings.BACKUP_STORAGE_DIR, f"_import_{userId[:8]}.tar.gz")
    try:
        with open(tmp_path, "wb") as dst:
            shutil.copyfileobj(file.file, dst, 65536)

        stats = await import_user_data(userId, tmp_path, conflict=conflict, selected_ids=ids)
    except Exception as e:
        logger.error("Import failed: %s", e)
        raise HTTPException(status_code=500, detail=f"Import failed: {e}")
    finally:
        try:
            os.remove(tmp_path)
        except OSError:
            pass

    return {"status": "ok", "stats": stats}


# ── Delete ───────────────────────────────────────────────────────────────────

@router.delete("/{userId}/backup/{backupId}", status_code=204)
async def delete_backup(
    userId: str,
    backupId: str,
    current_user_id: str = Depends(get_current_user_id),
):
    """Delete a backup file."""
    _verify_access(userId, current_user_id)

    history = _load_history()
    entry = next(
        (h for h in history if h["id"] == backupId and h["user_id"] == userId),
        None,
    )
    if entry:
        backup_path = os.path.join(settings.BACKUP_STORAGE_DIR, f"{backupId}.tar.gz")
        try:
            os.remove(backup_path)
        except FileNotFoundError:
            pass
        history = [h for h in history if h["id"] != backupId]
        _save_history(history)

    return Response(status_code=status.HTTP_204_NO_CONTENT)
