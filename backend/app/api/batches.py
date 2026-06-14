"""
Batch scanning API.

Endpoints:
  POST   /api/v1/users/{userId}/batches                     Create batch, get batchId
  POST   /api/v1/users/{userId}/batches/{batchId}/process   Upload files, start processing
  GET    /api/v1/users/{userId}/batches/{batchId}           Poll status
  DELETE /api/v1/users/{userId}/batches/{batchId}           Dismiss / cleanup
"""

import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi import status as http_status
from pydantic import BaseModel

from app.core.config import settings
from app.core.security import get_current_user_id
from app.services import batch_service
from app.services.image_service import process_image
from app.tasks.worker import process_batch_task

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/users", tags=["batches"])


# ─── Helpers ────────────────────────────────────────────────────────────────


def _require_owner(batch: dict, user_id: str) -> None:
    if batch["userId"] != user_id:
        raise HTTPException(status_code=http_status.HTTP_403_FORBIDDEN, detail="Access denied")


# ─── Endpoints ───────────────────────────────────────────────────────────────


class CreateBatchBody(BaseModel):
    batchTitle: str
    filenames: List[str]


@router.post("/{userId}/batches", status_code=http_status.HTTP_201_CREATED)
async def create_batch(
    userId: str,
    body: CreateBatchBody,
    current_user_id: str = Depends(get_current_user_id),
):
    """
    Create a new batch record and return its ID.
    Frontend stores the ID in localStorage immediately so reconnection
    works even after a page refresh.
    """
    if userId != current_user_id:
        raise HTTPException(status_code=403, detail="Access denied")

    if not body.batchTitle.strip():
        raise HTTPException(status_code=400, detail="batchTitle is required")
    if not body.filenames:
        raise HTTPException(status_code=400, detail="filenames must not be empty")

    batch_id = await batch_service.create_batch(userId, body.batchTitle.strip(), body.filenames)
    return {"batchId": batch_id, "status": "uploading"}


@router.post("/{userId}/batches/{batchId}/process")
async def start_processing(
    userId: str,
    batchId: str,
    files: List[UploadFile] = File(...),
    current_user_id: str = Depends(get_current_user_id),
):
    """
    Upload images and start background processing.
    Returns immediately; client polls GET /batches/{batchId} for progress.
    """
    if userId != current_user_id:
        raise HTTPException(status_code=403, detail="Access denied")

    batch = await batch_service.get_batch(userId, batchId)
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found")
    _require_owner(batch, userId)

    if batch["status"] not in ("uploading",):
        raise HTTPException(status_code=409, detail=f"Batch is already {batch['status']}")

    allowed_types = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"}
    batch_dir = os.path.join(settings.IMAGE_STORAGE_DIR, f"_scan_{batchId}")
    os.makedirs(batch_dir, exist_ok=True)
    entries: List[dict] = []
    for idx, f in enumerate(files):
        if f.content_type and f.content_type not in allowed_types:
            raise HTTPException(status_code=400, detail=f"Unsupported file type: {f.content_type}")
        contents = await f.read()
        if len(contents) > settings.MAX_UPLOAD_SIZE:
            raise HTTPException(status_code=413, detail=f"File too large: {f.filename} ({len(contents)} bytes)")
        processed, p_type = process_image(contents, f.content_type or "image/jpeg")
        fname = f"{idx:04d}.jpg"
        fpath = os.path.join(batch_dir, fname)
        with open(fpath, "wb") as outf:
            outf.write(processed)
        entries.append({"filename": fname, "mime": p_type, "orig_filename": f.filename or "image.jpg"})

    process_batch_task.delay(userId, batchId, batch_dir, entries, batch["batchTitle"])

    return {"batchId": batchId, "status": "processing", "total": len(entries)}


@router.get("/{userId}/batches")
async def list_active_batches(
    userId: str,
    current_user_id: str = Depends(get_current_user_id),
):
    """
    List all active batches for a user. 
    Allows other devices to 'discover' in-progress batches.
    """
    if userId != current_user_id:
        raise HTTPException(status_code=403, detail="Access denied")

    batch_ids = await batch_service.get_user_batches(userId)
    batches = []
    
    for bid in batch_ids:
        batch = await get_batch(userId, bid, current_user_id)
        if batch:
            batches.append(batch)
            
    # Sort by createdAt descending
    batches.sort(key=lambda x: x.get("createdAt", 0), reverse=True)
    return batches


@router.get("/{userId}/batches/{batchId}")
async def get_batch(
    userId: str,
    batchId: str,
    current_user_id: str = Depends(get_current_user_id),
):
    """
    Return current batch status.  Used by the frontend to poll progress
    and to reconnect after a hard refresh.

    Special case: if status is 'processing' but images are no longer in
    memory (server restarted), auto-marks the batch as 'failed'.
    """
    if userId != current_user_id:
        raise HTTPException(status_code=403, detail="Access denied")

    batch = await batch_service.get_batch(userId, batchId)
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found")
    _require_owner(batch, userId)

    # Detect stuck upload scenario (e.g., Nginx 413 error prevented start_processing)
    # If it's in 'uploading' state for more than 5 minutes, it's stuck.
    created_at = batch.get("createdAt", 0)
    now_ts = datetime.now(timezone.utc).timestamp()
    
    is_stuck_upload = batch["status"] == "uploading" and (now_ts - created_at > 60)
    
    # Detect server-restart or crash scenario: the temp directory is gone
    scan_dir = os.path.join(settings.IMAGE_STORAGE_DIR, f"_scan_{batchId}")
    is_stuck_processing = batch["status"] == "processing" and not os.path.isdir(scan_dir)
    
    if is_stuck_upload or is_stuck_processing:
        # Mark pending/processing items as failed
        msg = "Upload failed or timed out — please re-scan" if is_stuck_upload else "Server restarted during processing — please re-scan"
        for item in batch["items"]:
            if item["status"] in ("pending", "processing"):
                item["status"] = "failed"
                item["message"] = msg
        batch["status"] = "failed"
        
        # Persist the updated state to Redis
        import json
        r = await batch_service.get_redis()
        await r.setex(
            f"batch:{userId}:{batchId}",
            batch_service.BATCH_TTL,
            json.dumps(batch),
        )

    return batch


@router.delete("/{userId}/batches/{batchId}", status_code=http_status.HTTP_204_NO_CONTENT)
async def delete_batch(
    userId: str,
    batchId: str,
    current_user_id: str = Depends(get_current_user_id),
):
    """Dismiss a completed/failed batch and clean up Redis."""
    if userId != current_user_id:
        raise HTTPException(status_code=403, detail="Access denied")

    batch = await batch_service.get_batch(userId, batchId)
    if batch:
        _require_owner(batch, userId)
        await batch_service.delete_batch(userId, batchId)
