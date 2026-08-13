"""
Batch scanning API.

Endpoints:
  POST   /api/v1/users/{userId}/batches                          Create batch, get batchId
  POST   /api/v1/users/{userId}/batches/{batchId}/process        Upload files, start processing
  GET    /api/v1/users/{userId}/batches/{batchId}                Poll status
  POST   /api/v1/users/{userId}/batches/{batchId}/chunks/{n}/retry  Retry a failed chunk
  DELETE /api/v1/users/{userId}/batches/{batchId}                Dismiss / cleanup
"""

import hashlib
import json
import logging
import os
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi import status as http_status
from pydantic import BaseModel

from app.core.config import settings
from app.core.security import get_current_user_id
from app.services import batch_service
from app.services.data_adapter import DataService
from app.services.image_service import process_image
from app.tasks.worker import process_batch_task, retry_chunk_task, retry_item_task

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/users", tags=["batches"])


# ─── Helpers ────────────────────────────────────────────────────────────────


def _require_owner(batch: dict, user_id: str) -> None:
    if batch["userId"] != user_id:
        raise HTTPException(status_code=http_status.HTTP_403_FORBIDDEN, detail="Access denied")


async def _load_batch(user_id: str, batch_id: str) -> Optional[dict]:
    """Load a batch, applying the stuck detection, or None if it no longer exists."""
    batch = await batch_service.get_batch(user_id, batch_id)
    if not batch:
        return None

    created_at = batch.get("createdAt", 0)
    last_activity = batch.get("lastActivity", created_at)
    now_ts = datetime.now(timezone.utc).timestamp()

    # If no activity for 5 minutes, it's stuck
    is_stuck = batch["status"] in ("uploading", "processing") and (now_ts - last_activity > 300)

    if is_stuck:
        # Mark pending/processing items as failed
        msg = "Task timed out or was interrupted — please re-scan"
        for item in batch["items"]:
            if item["status"] in ("pending", "processing", "optimizing"):
                item["status"] = "failed"
                item["message"] = msg
                item["errorCode"] = "AI_TIMEOUT"
                item["stage"] = "done"
        batch["status"] = "failed"
        batch["lastActivity"] = now_ts

        # Persist the updated state to Redis
        r = await batch_service.get_redis()
        await r.setex(
            f"batch:{user_id}:{batch_id}",
            batch_service.BATCH_TTL,
            json.dumps(batch),
        )

        # Durable notification — Redis state is ephemeral (TTL), so without
        # this the stuck batch would vanish and the user couldn't see what
        # happened. Best-effort.
        try:
            from app.services.scan_error_service import log_error
            await log_error(
                user_id,
                kind="batch",
                code="AI_TIMEOUT",
                message=msg,
                title=batch.get("batchTitle") or "Receipt batch",
                batch_id=batch_id,
            )
        except Exception:
            logger.warning("Failed to log stuck-batch error", exc_info=True)

    return batch


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

    Computes SHA256 of each post-optimization image and short-circuits any
    that already exist in this user's receipts (cross-batch dedup). Returns
    immediately; client polls GET /batches/{batchId} for progress.
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

    # Pass 1: optimize + hash every file, but defer the dedup-DB-lookup
    # until we have all hashes so we can do one query.
    staged: List[dict] = []  # {idx, fname, mime, sha256, orig_filename}

    for idx, f in enumerate(files):
        if f.content_type and f.content_type not in allowed_types:
            raise HTTPException(status_code=400, detail=f"Unsupported file type: {f.content_type}")

        orig_name = f.filename or "image.jpg"
        await batch_service.update_item(
            userId, batchId, idx, "optimizing",
            stage="optimizing", message="Compressing image...",
            orig_filename=orig_name,
        )

        contents = await f.read()
        if len(contents) > settings.MAX_UPLOAD_SIZE:
            await batch_service.update_item(
                userId, batchId, idx, "failed",
                stage="done", message="File too large",
                error_code="IMAGE_TOO_LARGE",
            )
            raise HTTPException(
                status_code=413,
                detail=f"File too large: {f.filename} ({len(contents)} bytes)",
            )

        try:
            processed, p_type = process_image(contents, f.content_type or "image/jpeg")
            fname = f"{idx:04d}.jpg"
            fpath = os.path.join(batch_dir, fname)
            with open(fpath, "wb") as outf:
                outf.write(processed)
            sha256 = hashlib.sha256(processed).hexdigest()
            staged.append({
                "idx": idx,
                "fname": fname,
                "mime": p_type,
                "sha256": sha256,
                "orig_filename": orig_name,
            })
        except Exception as e:
            logger.error(f"Failed to process image {idx}: {e}")
            await batch_service.update_item(
                userId, batchId, idx, "failed",
                stage="done",
                message=f"Optimization failed: {str(e)[:140]}",
                error_code="IMAGE_INVALID",
            )
            continue

    # Pass 2: single DB lookup for duplicate hashes
    hashes = [s["sha256"] for s in staged]
    existing = await DataService.find_receipts_by_image_hashes(userId, hashes)

    # Pass 3: mark dupes, enqueue the rest
    for s in staged:
        if s["sha256"] in existing:
            existing_id = existing[s["sha256"]]
            # Remove the just-saved temp file — we won't process it
            try:
                os.remove(os.path.join(batch_dir, s["fname"]))
            except OSError:
                pass
            await batch_service.update_item(
                userId, batchId, s["idx"], "duplicate",
                stage="done",
                receipt_id=existing_id,
                message="Already scanned — linked to existing receipt",
            )
        else:
            await batch_service.update_item(
                userId, batchId, s["idx"], "pending",
                stage="queued", message="Ready for AI",
            )
            entries.append({
                "index": s["idx"],
                "filename": s["fname"],
                "mime": s["mime"],
                "sha256": s["sha256"],
                "orig_filename": s["orig_filename"],
            })

    if entries:
        process_batch_task.delay(userId, batchId, batch_dir, entries, batch["batchTitle"])
    else:
        # Everything was a duplicate or failed; nothing to dispatch
        final = "done" if not all(s["sha256"] not in existing for s in staged) else "failed"
        await batch_service.set_batch_status(userId, batchId, final)

        # Nothing was dispatched, so the worker-based failure logging never
        # runs — persist any item that failed during upload (e.g. an
        # IMAGE_INVALID optimization error) so it can't fail silently.
        if final == "failed":
            try:
                from app.services.scan_error_service import log_error
                fresh = await batch_service.get_batch(userId, batchId)
                failed_items = []
                for it in ((fresh or {}).get("items") or []):
                    if it["status"] == "failed":
                        failed_items.append({
                            "index": it.get("index"),
                            "filename": it.get("origFilename"),
                            "code": it.get("errorCode"),
                            "message": it.get("message"),
                        })
                if failed_items:
                    await log_error(
                        userId,
                        kind="item",
                        code="UNKNOWN",
                        message=f"{len(failed_items)} file(s) failed before AI processing",
                        title=batch["batchTitle"] or "Receipt batch",
                        batch_id=batchId,
                        data={"items": failed_items},
                    )
            except Exception as exc:
                logger.warning("Failed to log upload-phase failures: %s", exc)

    return {
        "batchId": batchId,
        "status": "processing" if entries else "done",
        "total": len(entries),
        "duplicates": len(staged) - len(entries),
    }


@router.get("/{userId}/batches")
async def list_active_batches(
    userId: str,
    current_user_id: str = Depends(get_current_user_id),
):
    """
    List all active batches for a user.
    Allows other devices to 'discover' in-progress batches.

    Stale ids whose Redis key has expired (24h TTL) are skipped and pruned
    from the user's index so they can't break the whole list.
    """
    if userId != current_user_id:
        raise HTTPException(status_code=403, detail="Access denied")

    batch_ids = await batch_service.get_user_batches(userId)
    batches = []

    for bid in batch_ids:
        batch = await _load_batch(userId, bid)
        if batch:
            batches.append(batch)

    # Drop ids whose batch data has expired from the index
    missing = batch_ids - {b["batchId"] for b in batches}
    if missing:
        await batch_service.remove_batches_from_index(userId, missing)

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
    """
    if userId != current_user_id:
        raise HTTPException(status_code=403, detail="Access denied")

    batch = await _load_batch(userId, batchId)
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found")
    _require_owner(batch, userId)

    return batch


@router.post("/{userId}/batches/{batchId}/chunks/{chunkIndex}/retry")
async def retry_chunk(
    userId: str,
    batchId: str,
    chunkIndex: int,
    current_user_id: str = Depends(get_current_user_id),
):
    """Re-enqueue a single failed chunk for processing."""
    if userId != current_user_id:
        raise HTTPException(status_code=403, detail="Access denied")

    batch = await batch_service.get_batch(userId, batchId)
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found")
    _require_owner(batch, userId)

    chunk = next((c for c in (batch.get("chunks") or []) if c["index"] == chunkIndex), None)
    if not chunk:
        raise HTTPException(status_code=404, detail=f"Chunk {chunkIndex} not found")
    if chunk["status"] not in ("failed",):
        raise HTTPException(
            status_code=409,
            detail=f"Chunk is {chunk['status']} — only failed chunks can be retried",
        )
    # Hard cap on user-triggered retries to prevent runaway API spend.
    if (chunk.get("attempts") or 0) >= 3:
        raise HTTPException(
            status_code=429,
            detail="Maximum retries (3) reached for this chunk — check API plan or upload as a new batch",
        )
    # Don't let the user retry a chunk that failed for an account-level reason
    # — retrying won't help and just wastes calls.
    bad_codes = {"AI_QUOTA_EXCEEDED", "AI_AUTH_FAILED"}
    if chunk.get("errorCode") in bad_codes:
        raise HTTPException(
            status_code=409,
            detail=f"Chunk failed with {chunk['errorCode']} — retrying will not help. Fix the account issue first.",
        )

    batch_dir = os.path.join(settings.IMAGE_STORAGE_DIR, f"_scan_{batchId}")
    if not os.path.isdir(batch_dir):
        raise HTTPException(
            status_code=410,
            detail="Batch images are no longer on disk — please re-upload",
        )

    # Build the slice of entries for this chunk from the persisted item list
    lo, hi = chunk["itemRange"]
    entries: List[dict] = []
    for i in range(lo, hi + 1):
        item = batch["items"][i]
        # Skip already-saved items so a retry doesn't overwrite them
        if item["status"] in ("done", "needs_review", "duplicate"):
            continue
        fname = f"{i:04d}.jpg"
        if not os.path.exists(os.path.join(batch_dir, fname)):
            continue
        entries.append({
            "index": i,
            "filename": fname,
            "mime": "image/jpeg",
            "sha256": None,
            "orig_filename": item.get("origFilename"),
        })

    if not entries:
        raise HTTPException(status_code=409, detail="No items in this chunk are eligible for retry")

    # Reset chunk + items to a fresh state before re-queueing
    await batch_service.update_chunk(
        userId, batchId, chunkIndex,
        status="pending", error_code=None, error_message=None,
    )
    for e in entries:
        await batch_service.update_item(
            userId, batchId, e["index"], "pending",
            stage="queued", message="Retry queued",
        )
    await batch_service.set_batch_status(userId, batchId, "processing")

    retry_chunk_task.delay(userId, batchId, batch_dir, entries, chunkIndex, batch["batchTitle"])
    return {"batchId": batchId, "chunkIndex": chunkIndex, "queued": len(entries)}


@router.post("/{userId}/batches/{batchId}/items/{itemIndex}/retry")
async def retry_item(
    userId: str,
    batchId: str,
    itemIndex: int,
    current_user_id: str = Depends(get_current_user_id),
):
    """Re-extract a single failed item. Useful when the parent chunk
    succeeded but Gemini returned null/error for this specific image."""
    if userId != current_user_id:
        raise HTTPException(status_code=403, detail="Access denied")

    batch = await batch_service.get_batch(userId, batchId)
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found")
    _require_owner(batch, userId)

    if itemIndex < 0 or itemIndex >= len(batch["items"]):
        raise HTTPException(status_code=404, detail=f"Item {itemIndex} not found")

    item = batch["items"][itemIndex]
    if item["status"] not in ("failed",):
        raise HTTPException(
            status_code=409,
            detail=f"Item is {item['status']} — only failed items can be retried",
        )
    if item.get("errorCode") in {"AI_QUOTA_EXCEEDED", "AI_AUTH_FAILED"}:
        raise HTTPException(
            status_code=409,
            detail=f"Item failed with {item['errorCode']} — retrying will not help. Fix the account issue first.",
        )

    batch_dir = os.path.join(settings.IMAGE_STORAGE_DIR, f"_scan_{batchId}")
    fname = f"{itemIndex:04d}.jpg"
    fpath = os.path.join(batch_dir, fname)
    if not os.path.exists(fpath):
        raise HTTPException(
            status_code=410,
            detail="Image is no longer on disk — please re-upload",
        )

    entry = {
        "index": itemIndex,
        "filename": fname,
        "mime": "image/jpeg",
        "sha256": None,
        "orig_filename": item.get("origFilename"),
        "chunkIndex": item.get("chunkIndex"),
    }

    await batch_service.update_item(
        userId, batchId, itemIndex, "pending",
        stage="queued", message="Retry queued",
    )
    # If the parent batch was 'done' or 'failed' overall, flip it back to
    # 'processing' so polling resumes.
    if batch["status"] in ("done", "failed"):
        await batch_service.set_batch_status(userId, batchId, "processing")

    retry_item_task.delay(userId, batchId, batch_dir, entry, batch["batchTitle"])
    return {"batchId": batchId, "itemIndex": itemIndex, "queued": True}


@router.delete("/{userId}/batches/{batchId}", status_code=http_status.HTTP_204_NO_CONTENT)
async def delete_batch(
    userId: str,
    batchId: str,
    current_user_id: str = Depends(get_current_user_id),
):
    """Dismiss a batch — removes Redis state AND on-disk scratch dir
    (the latter is retained while the batch is live so failed chunks can
    be re-extracted without re-uploading)."""
    if userId != current_user_id:
        raise HTTPException(status_code=403, detail="Access denied")

    batch = await batch_service.get_batch(userId, batchId)
    if batch:
        _require_owner(batch, userId)
        await batch_service.delete_batch(userId, batchId)

    batch_dir = os.path.join(settings.IMAGE_STORAGE_DIR, f"_scan_{batchId}")
    if os.path.isdir(batch_dir):
        import shutil
        try:
            shutil.rmtree(batch_dir)
        except Exception:
            logger.warning("Failed to clean batch dir %s", batch_dir, exc_info=True)
