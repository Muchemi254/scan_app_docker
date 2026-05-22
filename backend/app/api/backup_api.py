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
import uuid
from datetime import datetime, timezone
from typing import Optional, List

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import Response

from app.core.security import get_current_user_id
from app.services.backup_service import export_user_data, import_user_data, parse_backup
from app.core.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/users", tags=["backup"])

# Store backup history in a simple JSON file (can be upgraded to DB later)
BACKUP_DB = os.path.join(
    os.path.dirname(settings.IMAGE_STORAGE_DIR), "backup_history.json"
)


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
    """Create a backup of all user data + images and return as download."""
    _verify_access(userId, current_user_id)

    try:
        backup_bytes = await export_user_data(userId)
    except Exception as e:
        logger.error("Backup export failed: %s", e)
        raise HTTPException(status_code=500, detail=f"Backup failed: {e}")

    # Save history
    backup_id = uuid.uuid4().hex[:8]
    timestamp = datetime.now(timezone.utc).isoformat()
    filename = f"scanapp_backup_{userId[:8]}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.tar.gz"

    # Store backup file
    backup_dir = os.path.join(os.path.dirname(settings.IMAGE_STORAGE_DIR), "backups")
    os.makedirs(backup_dir, exist_ok=True)
    backup_path = os.path.join(backup_dir, f"{backup_id}.tar.gz")
    with open(backup_path, "wb") as f:
        f.write(backup_bytes)

    # Record in history
    history = _load_history()
    history.insert(0, {
        "id": backup_id,
        "user_id": userId,
        "filename": filename,
        "created_at": timestamp,
        "size_bytes": len(backup_bytes),
        "size_kb": len(backup_bytes) // 1024,
    })
    _save_history(history)

    return Response(
        content=backup_bytes,
        media_type="application/gzip",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(len(backup_bytes)),
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

    # Check if files still exist
    for h in user_backups:
        backup_path = os.path.join(
            os.path.dirname(settings.IMAGE_STORAGE_DIR), "backups",
            f"{h['id']}.tar.gz"
        )
        h["available"] = os.path.exists(backup_path)

    return user_backups


# ── Download ─────────────────────────────────────────────────────────────────

@router.get("/{userId}/backup/download/{backupId}")
async def download_backup(
    userId: str,
    backupId: str,
    current_user_id: str = Depends(get_current_user_id),
):
    """Download a previously created backup."""
    _verify_access(userId, current_user_id)

    history = _load_history()
    entry = next(
        (h for h in history if h["id"] == backupId and h["user_id"] == userId),
        None,
    )
    if not entry:
        raise HTTPException(status_code=404, detail="Backup not found")

    backup_path = os.path.join(
        os.path.dirname(settings.IMAGE_STORAGE_DIR), "backups",
        f"{backupId}.tar.gz"
    )
    if not os.path.exists(backup_path):
        raise HTTPException(status_code=404, detail="Backup file no longer available")

    with open(backup_path, "rb") as f:
        content = f.read()

    return Response(
        content=content,
        media_type="application/gzip",
        headers={
            "Content-Disposition": f'attachment; filename="{entry["filename"]}"',
            "Content-Length": str(len(content)),
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

    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Empty file")

    try:
        preview = parse_backup(contents)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid backup file: {e}")

    return preview


# ── Import ────────────────────────────────────────────────────────────────────

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

    contents = await file.read()
    if not contents:
        raise HTTPException(status_code=400, detail="Empty file")

    try:
        stats = await import_user_data(userId, contents, conflict=conflict, selected_ids=ids)
    except Exception as e:
        logger.error("Import failed: %s", e)
        raise HTTPException(status_code=500, detail=f"Import failed: {e}")

    return {"status": "ok", "stats": stats}


# ── Delete ────────────────────────────────────────────────────────────────────

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
        backup_path = os.path.join(
            os.path.dirname(settings.IMAGE_STORAGE_DIR), "backups",
            f"{backupId}.tar.gz"
        )
        try:
            os.remove(backup_path)
        except FileNotFoundError:
            pass
        history = [h for h in history if h["id"] != backupId]
        _save_history(history)
