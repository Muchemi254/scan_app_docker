"""
Batch scanning API.

Scan sessions are durable (Postgres). Local prep ends in `prepared` holding
state; AI is dispatched explicitly per group via the dispatch endpoint.

Endpoints:
  POST   /api/v1/users/{userId}/batches                          Create batch, get batchId
  POST   /api/v1/users/{userId}/batches/{batchId}/process        Upload + locally prep, then HOLD
  POST   /api/v1/users/{userId}/batches/{batchId}/dispatch       Send a prepared group / items / all to AI
  GET    /api/v1/users/{userId}/batches/{batchId}                Poll status
  POST   /api/v1/users/{userId}/batches/{batchId}/chunks/{n}/retry  Retry a failed chunk
  DELETE /api/v1/users/{userId}/batches/{batchId}                Dismiss / cleanup
"""

import hashlib
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

# Images auto-grouped past this many prepared items (≤ this = one group).
GROUP_SIZE = 50


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

    # Item-level progress keeps the session alive: the worker only bumps
    # session `updated_at` on set_batch_status/chunk updates, so a long
    # Gemini run must still count item updated_at as recent activity —
    # otherwise a slow-but-alive batch would be judged "stuck".
    for it in batch.get("items") or []:
        it_ts = it.get("updatedAt") or 0
        if it_ts > last_activity:
            last_activity = it_ts

    # If no activity for 5 minutes, it's stuck
    is_stuck = batch["status"] in ("uploading", "processing") and (now_ts - last_activity > 300)

    if is_stuck:
        # ONLY in-flight items are stuck. Held `prepared` items were never
        # dispatched — leave them alone so the session stays dispatchable
        # and can still be sent later.
        msg = "Task timed out or was interrupted — please re-scan"
        for item in batch["items"]:
            if item["status"] in ("pending", "processing", "optimizing", "extracting"):
                await batch_service.update_item(
                    user_id, batch_id, item["index"], "failed",
                    message=msg, stage="done", error_code="AI_TIMEOUT",
                )
        # Session status derives from items: if prepared items remain it is
        # back to `prepared` (dispatchable), otherwise `failed`. No forced
        # terminal status — that would lock out untouched held groups.

        # Durable notification — the session is durable, but a notification
        # makes the stuck batch visible without opening the Scans page.
        # Best-effort.
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

        batch = await batch_service.get_batch(user_id, batch_id)

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
    Upload images and locally prep them into `prepared` holding state.

    Computes SHA256 of each post-optimization image, short-circuits any that
    already exist in this user's receipts (cross-batch dedup), stores the
    optimized images on disk, and marks every surviving item `prepared`.
    Nothing is sent to AI — the user decides what to dispatch (per group,
    per item, or all) via POST .../dispatch, now or weeks later.
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

    # Pass 3: mark dupes, hold the rest as `prepared`. No AI is dispatched
    # here — the user decides what to send via POST .../dispatch (per group,
    # per item, or all). Everything is durable, so a held session can be
    # resumed days or weeks later without re-uploading.
    prepared_count = 0
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
            if prepared_count >= GROUP_SIZE:
                group_index = prepared_count // GROUP_SIZE
            else:
                group_index = 0
            await batch_service.set_prepared(
                userId, batchId, s["idx"],
                image_filename=s["fname"], mime=s["mime"],
                sha256=s["sha256"], orig_filename=s["orig_filename"],
                group_index=group_index,
            )
            prepared_count += 1

    group_count = 0 if prepared_count == 0 else (
        1 if prepared_count <= GROUP_SIZE
        else (prepared_count + GROUP_SIZE - 1) // GROUP_SIZE
    )
    await batch_service.finalize_prepared(userId, batchId, prepared_count, group_count)

    # Nothing was dispatched, so the worker-based failure logging never runs —
    # persist any item that failed during upload (e.g. an IMAGE_INVALID
    # optimization error) so it can't fail silently.
    try:
        fresh = await batch_service.get_batch(userId, batchId)
        failed_items = [
            it for it in ((fresh or {}).get("items") or []) if it["status"] == "failed"
        ]
        if failed_items:
            from app.services.scan_error_service import log_error
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
        "status": "prepared" if prepared_count else "done",
        "prepared": prepared_count,
        "groups": group_count,
        "duplicates": len(staged) - prepared_count,
    }


class DispatchBody(BaseModel):
    groups: Optional[List[int]] = None
    items: Optional[List[int]] = None
    all: Optional[bool] = False


@router.post("/{userId}/batches/{batchId}/dispatch")
async def dispatch_scan(
    userId: str,
    batchId: str,
    body: DispatchBody,
    current_user_id: str = Depends(get_current_user_id),
):
    """
    Send prepared images to AI — per group, per item, or all.

    Only items still in `prepared` state are eligible, so the same image is
    never sent twice. Dispatched images are read from the on-disk scratch
    dir referenced by the durable item rows (no re-upload). Returns
    immediately; client polls GET /batches/{batchId} for progress.
    """
    if userId != current_user_id:
        raise HTTPException(status_code=403, detail="Access denied")

    batch = await batch_service.get_batch(userId, batchId)
    if not batch:
        raise HTTPException(status_code=404, detail="Batch not found")
    _require_owner(batch, userId)

    selected = await batch_service.get_dispatch_items(
        userId, batchId,
        groups=body.groups, items=body.items, all_=bool(body.all),
    )
    if not selected:
        raise HTTPException(
            status_code=409,
            detail="No prepared items match this dispatch selection",
        )

    batch_dir = os.path.join(settings.IMAGE_STORAGE_DIR, f"_scan_{batchId}")
    if not os.path.isdir(batch_dir):
        raise HTTPException(
            status_code=410,
            detail="Prepared images are no longer on disk — please re-upload",
        )

    indexes = [i["index"] for i in selected]
    # Atomic: only still-prepared indexes are flipped, so a parallel dispatch
    # of the same group won't enqueue already-sent images.
    flipped = await batch_service.mark_queued(userId, batchId, indexes)
    if not flipped:
        raise HTTPException(
            status_code=409,
            detail="Those images are already being sent — nothing new was queued",
        )
    await batch_service.set_batch_status(userId, batchId, "processing")

    by_index = {i["index"]: i for i in selected}
    entries = [
        {
            "index": i,
            "filename": by_index[i]["filename"],
            "mime": by_index[i].get("mime") or "image/jpeg",
            "sha256": by_index[i].get("sha256"),
            "orig_filename": by_index[i].get("origFilename"),
        }
        for i in flipped
    ]
    process_batch_task.delay(userId, batchId, batch_dir, entries, batch["batchTitle"])
    return {"batchId": batchId, "dispatched": len(entries), "status": "processing"}


@router.get("/{userId}/batches")
async def list_active_batches(
    userId: str,
    current_user_id: str = Depends(get_current_user_id),
):
    """
    List all scan sessions for a user (prepared, processing, done, failed).

    Sessions are durable in Postgres — a held `prepared` session from weeks
    ago still appears here, ready to be dispatched. Allows other devices to
    'discover' the same sessions.
    """
    if userId != current_user_id:
        raise HTTPException(status_code=403, detail="Access denied")

    batch_ids = await batch_service.get_user_batches(userId)
    batches = []

    for bid in batch_ids:
        batch = await _load_batch(userId, bid)
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
