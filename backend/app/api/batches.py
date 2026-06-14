"""
Batch scanning API.

Endpoints:
  POST   /api/v1/users/{userId}/batches                     Create batch, get batchId
  POST   /api/v1/users/{userId}/batches/{batchId}/process   Upload files, start processing
  GET    /api/v1/users/{userId}/batches/{batchId}           Poll status
  DELETE /api/v1/users/{userId}/batches/{batchId}           Dismiss / cleanup
"""

import asyncio
import base64
import logging
import os
from datetime import datetime, timezone
from typing import List

from fastapi import APIRouter, BackgroundTasks, Depends, File, HTTPException, UploadFile
from fastapi import status as http_status
from pydantic import BaseModel

from app.core.config import settings
from app.core.security import get_current_user_id
from app.services import batch_service
from app.services.data_adapter import DataService
from app.services.database_service import save_image, save_thumbnail
from app.services.firebase_service import StorageService
from app.services.gemini import extract_receipt_batch
from app.services.image_service import process_image, generate_thumbnail, BATCH_CHUNK_SIZE, has_missing_fields
from app.services.audit_service import AuditService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/users", tags=["batches"])


# ─── Helpers ────────────────────────────────────────────────────────────────


def _require_owner(batch: dict, user_id: str) -> None:
    if batch["userId"] != user_id:
        raise HTTPException(status_code=http_status.HTTP_403_FORBIDDEN, detail="Access denied")


# ─── Background task ────────────────────────────────────────────────────────


async def _process_batch(batch_id: str, user_id: str, batch_title: str) -> None:
    """Process every image in a batch using AI batching.  Reads images from disk."""
    info = batch_service.get_image_dir(batch_id)
    if not info:
        logger.error(f"Batch {batch_id}: images not found on disk (server restarted?)")
        await batch_service.set_batch_status(user_id, batch_id, "failed")
        return

    entries = info["files"]
    batch_dir = info["dir"]
    await batch_service.set_batch_status(user_id, batch_id, "processing")
    logger.info(f"Batch {batch_id}: processing {len(entries)} images for user {user_id}")

    # Process in chunks for AI efficiency (shared BATCH_CHUNK_SIZE from image_service)
    for i in range(0, len(entries), BATCH_CHUNK_SIZE):
            chunk = entries[i : i + BATCH_CHUNK_SIZE]
            chunk_indices = list(range(i, i + len(chunk)))

            try:
                # 1. Optimize all images in chunk — read from disk
                processed_chunk = []
                for idx, entry in zip(chunk_indices, chunk):
                    await batch_service.update_item(user_id, batch_id, idx, "processing", message="Optimizing image...")
                    fpath = os.path.join(batch_dir, entry["filename"])
                    with open(fpath, "rb") as f:
                        raw = f.read()
                    processed, p_type = process_image(raw, entry.get("mime", "image/jpeg"))
                    processed_chunk.append((processed, p_type, entry.get("orig_filename", entry["filename"])))

                # 2. Extract via Gemini (Batch call)
                for idx in chunk_indices:
                    await batch_service.update_item(user_id, batch_id, idx, "processing", message="AI batch extraction...")

                # Prepare for AI: [(b64, mime), ...]
                ai_input = [
                    (base64.standard_b64encode(p[0]).decode(), p[1])
                    for p in processed_chunk
                ]

                from app.services.gemini import get_gemini_config
                api_key, model_id, provider = await get_gemini_config(user_id)
                extracted_results = await extract_receipt_batch(ai_input, api_key, model_id, provider)

                # 3. Save results for each item
                for idx, result, (p_bytes, p_type, filename) in zip(chunk_indices, extracted_results, processed_chunk):
                    if result is None:
                        await batch_service.update_item(user_id, batch_id, idx, "failed", message="AI failed to extract data")
                        continue

                    try:
                        data = result.model_dump(exclude_unset=True)
                        receipt_status = "needs_review"

                        import uuid as _batch_uuid
                        pre_id = str(_batch_uuid.uuid4())

                        await batch_service.update_item(user_id, batch_id, idx, "processing", message="Saving images...")
                        thumb = generate_thumbnail(p_bytes, "image/jpeg")

                        if settings.USE_POSTGRES:
                            img_filename = save_image(pre_id, p_bytes)
                            thumb_filename = save_thumbnail(pre_id, thumb) if thumb else None
                        else:
                            base_name = f"receipt_{int(datetime.now(timezone.utc).timestamp())}_{idx}"
                            image_url, _ = await StorageService.upload_receipt_images(
                                user_id, base_name, p_bytes, thumb,
                            )

                        await batch_service.update_item(user_id, batch_id, idx, "processing", message="Saving to database...")
                        data.update(
                            id=pre_id,
                            userId=user_id,
                            batchTitle=batch_title,
                            status=receipt_status,
                        )
                        if settings.USE_POSTGRES:
                            data["image_filename"] = img_filename
                            if thumb_filename:
                                data["thumbnail_filename"] = thumb_filename
                        else:
                            data["imageUrl"] = image_url
                        receipt_id = await DataService.create_receipt(user_id, data)

                        await AuditService.log_create(user_id, receipt_id, data, user_id)

                        has_missing = has_missing_fields(data)
                        item_status = "done" if not has_missing else "needs_review"
                        msg = "Saved successfully" if not has_missing else "Missing fields — saved for review"
                        await batch_service.update_item(user_id, batch_id, idx, item_status, receipt_id=receipt_id, message=msg)
                    except Exception as item_exc:
                        logger.error(f"Batch {batch_id} item {idx} failed: {item_exc}")
                        if settings.USE_POSTGRES:
                            from app.services.database_service import delete_receipt_images
                            delete_receipt_images(pre_id)
                        await batch_service.update_item(user_id, batch_id, idx, "failed", message=str(item_exc)[:200])

            except asyncio.CancelledError:
                raise
            except Exception as chunk_exc:
                logger.error(f"Batch {batch_id} chunk failed: {chunk_exc}")
                for idx in chunk_indices:
                    batch_state = await batch_service.get_batch(user_id, batch_id)
                    if batch_state and batch_state["items"][idx]["status"] == "processing":
                        await batch_service.update_item(user_id, batch_id, idx, "failed", message=f"Chunk error: {str(chunk_exc)[:100]}")

    batch_service.clear_images(batch_id)
    await batch_service.set_batch_status(user_id, batch_id, "done")
    logger.info(f"Batch {batch_id}: all items processed")


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
    background_tasks: BackgroundTasks,
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

    batch_service.store_images(batchId, batch_dir, entries)
    background_tasks.add_task(_process_batch, batchId, userId, batch["batchTitle"])

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
    
    # Detect server-restart or crash scenario
    is_stuck_processing = batch["status"] == "processing" and not batch_service.has_images(batchId)
    
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
            f"batch:{batchId}",
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

    batch = await batch_service.get_batch(user_id, batchId)
    if batch:
        _require_owner(batch, userId)
        await batch_service.delete_batch(user_id, batchId)
