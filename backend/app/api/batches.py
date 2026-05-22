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
from app.services.gemini import extract_receipt_data, extract_receipt_batch
from app.services.image_service import process_image, generate_thumbnail
from app.services.audit_service import AuditService

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/users", tags=["batches"])


# ─── Helpers ────────────────────────────────────────────────────────────────


def _require_owner(batch: dict, user_id: str) -> None:
    if batch["userId"] != user_id:
        raise HTTPException(status_code=http_status.HTTP_403_FORBIDDEN, detail="Access denied")


def _has_missing_fields(data: dict) -> bool:
    """Mirror the frontend's hasMissingFields logic."""
    required = [
        "supplier", "receiptDate", "totalAmount", "taxAmount",
        "category", "invoiceNumber", "kraPin", "cuInvoice",
    ]
    for field in required:
        val = data.get(field)
        if not val or str(val).strip() == "" or val == "N/A":
            return True
    items = data.get("items") or []
    if not items:
        return True
    for item in items:
        if not item.get("name") or not item.get("quantity"):
            return True
        if not item.get("isZeroRated") and not item.get("tax"):
            return True
    return False


# ─── Background task ────────────────────────────────────────────────────────


async def _process_batch(batch_id: str, user_id: str, batch_title: str) -> None:
    """
    Process every image in a batch using AI batching.
    """
    images = batch_service.get_images(batch_id)
    if not images:
        logger.error(f"Batch {batch_id}: images not found in memory (server restarted?)")
        await batch_service.set_batch_status(batch_id, "failed")
        return

    await batch_service.set_batch_status(batch_id, "processing")
    logger.info(f"Batch {batch_id}: processing {len(images)} images for user {user_id}")

    # Process in chunks of 5 for AI efficiency
    CHUNK_SIZE = 5
    for i in range(0, len(images), CHUNK_SIZE):
        chunk = images[i : i + CHUNK_SIZE]
        chunk_indices = list(range(i, i + len(chunk)))
        
        try:
            # 1. Optimize all images in chunk
            processed_chunk = []
            for idx, (filename, image_bytes, content_type) in zip(chunk_indices, chunk):
                await batch_service.update_item(batch_id, idx, "processing", message="Optimizing image...")
                processed, p_type = process_image(image_bytes, content_type)
                processed_chunk.append((processed, p_type, filename))

            # 2. Extract via Gemini (Batch call)
            for idx in chunk_indices:
                await batch_service.update_item(batch_id, idx, "processing", message="AI batch extraction...")
            
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
                    await batch_service.update_item(batch_id, idx, "failed", message="AI failed to extract data")
                    continue
                
                try:
                    data = result.model_dump(exclude_unset=True)
                    has_missing = _has_missing_fields(data)
                    receipt_status = "needs_review" if has_missing else "processed"

                    # Pre-generate UUID for image filename
                    import uuid as _batch_uuid
                    pre_id = str(_batch_uuid.uuid4())

                    # Save images
                    await batch_service.update_item(batch_id, idx, "processing", message="Saving images...")
                    thumb = generate_thumbnail(p_bytes, "image/jpeg")

                    if settings.USE_POSTGRES:
                        img_filename = save_image(pre_id, p_bytes)
                        thumb_filename = save_thumbnail(pre_id, thumb) if thumb else None
                    else:
                        base_name = f"receipt_{int(datetime.now(timezone.utc).timestamp())}_{idx}"
                        image_url, _ = await StorageService.upload_receipt_images(
                            user_id, base_name, p_bytes, thumb,
                        )

                    # Save to database
                    await batch_service.update_item(batch_id, idx, "processing", message="Saving to database...")
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

                    item_status = "done" if not has_missing else "needs_review"
                    msg = "Saved successfully" if not has_missing else "Missing fields — saved for review"
                    await batch_service.update_item(batch_id, idx, item_status, receipt_id=receipt_id, message=msg)
                except Exception as item_exc:
                    logger.error(f"Batch {batch_id} item {idx} failed: {item_exc}")
                    # Clean up orphaned images
                    if settings.USE_POSTGRES:
                        from app.services.database_service import delete_receipt_images
                        delete_receipt_images(pre_id)
                    await batch_service.update_item(batch_id, idx, "failed", message=str(item_exc)[:200])

        except asyncio.CancelledError:
            raise
        except Exception as chunk_exc:
            logger.error(f"Batch {batch_id} chunk failed: {chunk_exc}")
            # Mark remaining items in this chunk as failed
            for idx in chunk_indices:
                batch_state = await batch_service.get_batch(batch_id)
                if batch_state and batch_state["items"][idx]["status"] == "processing":
                     await batch_service.update_item(batch_id, idx, "failed", message=f"Chunk error: {str(chunk_exc)[:100]}")

    batch_service.clear_images(batch_id)
    await batch_service.set_batch_status(batch_id, "done")
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

    batch = await batch_service.get_batch(batchId)
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found")
    _require_owner(batch, userId)

    if batch["status"] not in ("uploading",):
        raise HTTPException(status_code=409, detail=f"Batch is already {batch['status']}")

    allowed_types = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"}
    images: List[tuple] = []
    for f in files:
        if f.content_type and f.content_type not in allowed_types:
            raise HTTPException(status_code=400, detail=f"Unsupported file type: {f.content_type}")
        contents = await f.read()
        if len(contents) > settings.MAX_UPLOAD_SIZE:
            raise HTTPException(status_code=413, detail=f"File too large: {f.filename} ({len(contents)} bytes)")
        images.append((f.filename or "image.jpg", contents, f.content_type or "image/jpeg"))

    batch_service.store_images(batchId, images)
    background_tasks.add_task(_process_batch, batchId, userId, batch["batchTitle"])

    return {"batchId": batchId, "status": "processing", "total": len(images)}


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

    batch = await batch_service.get_batch(batchId)
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

    batch = await batch_service.get_batch(batchId)
    if batch:
        _require_owner(batch, userId)
        await batch_service.delete_batch(batchId)
