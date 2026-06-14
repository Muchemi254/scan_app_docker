import logging
import asyncio
import os
import base64
import shutil
import uuid
from typing import Optional, Callable, Awaitable
from app.core.celery_app import celery_app
from app.services.gemini import extract_receipt_data, extract_receipt_batch
from app.services.task_service import TaskService
from app.services.image_service import BATCH_CHUNK_SIZE, MAX_AI_CONCURRENCY, process_image, generate_thumbnail, has_missing_fields
from app.services.data_adapter import DataService
from app.services.audit_service import AuditService
from app.schemas.task import TaskStatus, TaskProgressUpdate

logger = logging.getLogger(__name__)

ProgressFn = Callable[[int, str], Awaitable[None]]
ItemResultFn = Callable[[int, Optional[dict]], Awaitable[None]]
ItemUpdateFn = Callable[[int, str, Optional[str], str], Awaitable[None]]


# ── Single-receipt task (unchanged) ──────────────────────────────────────────

@celery_app.task(name="tasks.extract_receipt")
def extract_receipt_task(user_id: str, task_id: str, image_base64: str, mime_type: str):
    return asyncio.run(_extract_receipt_sync(user_id, task_id, image_base64, mime_type))


async def _extract_receipt_sync(user_id: str, task_id: str, image_base64: str, mime_type: str):
    try:
        await TaskService.update_progress(user_id, task_id, TaskProgressUpdate(
            status=TaskStatus.PROCESSING, percentage=50, message="Processing receipt..."
        ))
        result = await extract_receipt_data(image_base64, mime_type, user_id)
        await TaskService.add_task_result(user_id, task_id, "receipt", result.model_dump())
        await TaskService.update_progress(user_id, task_id, TaskProgressUpdate(
            status=TaskStatus.COMPLETED, percentage=100, message="Extraction complete"
        ))
    except Exception as e:
        logger.error(f"Task {task_id} failed: {e}")
        await TaskService.update_progress(user_id, task_id, TaskProgressUpdate(
            status=TaskStatus.FAILED, percentage=0, message=str(e), error=str(e)
        ))


# ── Shared batch extraction engine ───────────────────────────────────────────

async def _run_batch_extraction(
    user_id: str,
    batch_dir: str,
    entries: list,
    *,
    batch_title: str = "",
    on_progress: Optional[ProgressFn] = None,
    on_item_update: Optional[ItemUpdateFn] = None,
    on_item_result: Optional[ItemResultFn] = None,
) -> list:
    """
    Shared batch pipeline: parallel Gemini extraction + save + audit + cleanup.

    Returns list of (img_bytes, receipt_data) pairs — same order as entries.
    img_bytes is None for failed items.

    Callbacks (all optional, all awaitable):
      on_progress(pct, message)     — coarse progress updates
      on_item_update(idx, status, receipt_id, message)  — per-item status
      on_item_result(idx, saved_data_or_None)          — store result

    cleanup of batch_dir is handled by the callers in their finally blocks.
    """
    from app.core.config import settings
    from app.services.gemini import get_gemini_config

    api_key, model_id, active_provider = await get_gemini_config(user_id)
    total_items = len(entries)

    if on_progress:
        await on_progress(5, f"Starting batch of {total_items} with {active_provider}...")

    # ── Phase 1: Parallel Gemini extraction ──
    all_results = [None] * total_items

    async def process_chunk(chunk_start, chunk):
        b64_images = []
        img_bytes_list = []
        for entry in chunk:
            fpath = os.path.join(batch_dir, entry["filename"])
            with open(fpath, "rb") as f:
                img_bytes = f.read()
            b64 = base64.standard_b64encode(img_bytes).decode()
            b64_images.append((b64, entry.get("mime", "image/jpeg")))
            img_bytes_list.append(img_bytes)

        chunk_results = await extract_receipt_batch(
            b64_images, api_key, model_id, active_provider, user_id=user_id
        )
        return [(chunk_start + i,
                 img_bytes_list[i] if chunk_results[i] is not None else None,
                 chunk_results[i])
                for i in range(len(chunk_results))]

    sem = asyncio.Semaphore(MAX_AI_CONCURRENCY)

    async def bounded(chunk_start, chunk):
        async with sem:
            return await process_chunk(chunk_start, chunk)

    tasks = []
    for chunk_start in range(0, total_items, BATCH_CHUNK_SIZE):
        chunk = entries[chunk_start : chunk_start + BATCH_CHUNK_SIZE]
        tasks.append(bounded(chunk_start, chunk))

    if on_progress:
        await on_progress(10, f"AI: {total_items} images in {len(tasks)} chunks ({MAX_AI_CONCURRENCY} parallel)...")

    chunk_results = await asyncio.gather(*tasks, return_exceptions=True)

    # Process each chunk's results, handling per-chunk errors
    for ci, result in enumerate(chunk_results):
        chunk_start = ci * BATCH_CHUNK_SIZE
        if isinstance(result, Exception):
            logger.error(f"Chunk {ci} failed: {result}")
            if on_item_update:
                for gi in range(chunk_start, min(chunk_start + BATCH_CHUNK_SIZE, total_items)):
                    await on_item_update(gi, "failed", None, f"AI chunk error: {str(result)[:100]}")
            continue
        for global_idx, img_bytes, receipt in result:
            all_results[global_idx] = (img_bytes, receipt)

    if on_progress:
        await on_progress(40, "AI extraction done — saving receipts...")

    # ── Phase 2: Save receipts + images + audit ──
    for i in range(total_items):
        item = all_results[i]
        if item is None:
            if on_item_update:
                await on_item_update(i, "failed", None, "AI failed to extract data")
            if on_item_result:
                await on_item_result(i, None)
            continue

        img_bytes, res = item
        if res is None:
            if on_item_update:
                await on_item_update(i, "failed", None, "AI extraction returned empty")
            if on_item_result:
                await on_item_result(i, None)
            continue

        if on_progress:
            await on_progress(40 + int(60 * i / total_items), f"Saving {i + 1} of {total_items}...")

        try:
            data = res.model_dump(exclude_unset=True)
            data["status"] = "needs_review"
            has_missing = has_missing_fields(data)
            receipt_id = str(uuid.uuid4())

            # Save images
            img_filename = None
            thumb_filename = None
            if img_bytes and settings.USE_POSTGRES:
                from app.services.database_service import save_image, save_thumbnail
                img_filename = save_image(receipt_id, img_bytes)
                thumb = generate_thumbnail(img_bytes, "image/jpeg")
                thumb_filename = save_thumbnail(receipt_id, thumb) if thumb else None

            # Save receipt to database
            data["id"] = receipt_id
            data["userId"] = user_id
            if batch_title:
                data["batchTitle"] = batch_title
            if settings.USE_POSTGRES:
                data["image_filename"] = img_filename
                if thumb_filename:
                    data["thumbnail_filename"] = thumb_filename

            await DataService.create_receipt(user_id, data)
            await AuditService.log_create(user_id, receipt_id, data, user_id)

            saved_data = dict(data)
            saved_data["status"] = "needs_review" if has_missing else "processed"

            if on_item_update:
                item_status = "done" if not has_missing else "needs_review"
                msg = "Saved successfully" if not has_missing else "Missing fields — saved for review"
                await on_item_update(i, item_status, receipt_id, msg)

            if on_item_result:
                await on_item_result(i, saved_data)

        except Exception as item_exc:
            logger.error(f"Item {i} save failed: {item_exc}")
            if settings.USE_POSTGRES:
                from app.services.database_service import delete_receipt_images
                delete_receipt_images(receipt_id)
            if on_item_update:
                await on_item_update(i, "failed", receipt_id, str(item_exc)[:200])
            if on_item_result:
                await on_item_result(i, None)

    return all_results


# ── Batch-extract Celery task (thin wrapper) ─────────────────────────────────

@celery_app.task(name="tasks.extract_receipt_batch")
def extract_receipt_batch_task(user_id: str, task_id: str, batch_dir: str,
                                image_entries: list, provider: str = "gemini"):
    return asyncio.run(_extract_receipt_batch_sync(user_id, task_id, batch_dir, image_entries, provider))


async def _extract_receipt_batch_sync(user_id: str, task_id: str, batch_dir: str,
                                       image_entries: list, provider: str = "gemini"):
    try:
        async def report(pct, msg):
            await TaskService.update_progress(user_id, task_id, TaskProgressUpdate(
                status=TaskStatus.PROCESSING, percentage=pct, message=msg
            ))

        async def store(i, data):
            await TaskService.add_task_result(user_id, task_id, f"item_{i}", data)

        await _run_batch_extraction(
            user_id, batch_dir, image_entries,
            on_progress=report,
            on_item_result=store,
        )

        await TaskService.update_progress(user_id, task_id, TaskProgressUpdate(
            status=TaskStatus.COMPLETED, percentage=100,
            message="Batch extraction complete — receipts saved"
        ))

    except Exception as e:
        logger.error(f"Batch task {task_id} failed: {e}")
        await TaskService.update_progress(user_id, task_id, TaskProgressUpdate(
            status=TaskStatus.FAILED, percentage=0,
            message=str(e), error=str(e)
        ))
    finally:
        try:
            if os.path.isdir(batch_dir):
                shutil.rmtree(batch_dir)
        except Exception:
            pass


# ── ScannerPage batch Celery task (thin wrapper) ─────────────────────────────

@celery_app.task(name="tasks.process_batch")
def process_batch_task(user_id: str, batch_id: str, batch_dir: str, entries: list, batch_title: str = ""):
    import asyncio as _asyncio
    loop = _asyncio.get_event_loop()
    return loop.run_until_complete(_process_batch_sync(user_id, batch_id, batch_dir, entries, batch_title))


async def _process_batch_sync(user_id: str, batch_id: str, batch_dir: str,
                               entries: list, batch_title: str = ""):
    try:
        from app.services import batch_service

        await batch_service.set_batch_status(user_id, batch_id, "processing")
        logger.info(f"Batch {batch_id}: processing {len(entries)} images")

        async def item_update(idx, status, receipt_id, message):
            await batch_service.update_item(user_id, batch_id, idx, status,
                                            receipt_id=receipt_id, message=message)

        await _run_batch_extraction(
            user_id, batch_dir, entries,
            batch_title=batch_title,
            on_item_update=item_update,
        )

        await batch_service.set_batch_status(user_id, batch_id, "done")
        logger.info(f"Batch {batch_id}: all items processed")

    except Exception as e:
        logger.error(f"Batch {batch_id} task failed: {e}")
        try:
            from app.services import batch_service
            await batch_service.set_batch_status(user_id, batch_id, "failed")
        except Exception:
            pass
        raise
    finally:
        try:
            if os.path.isdir(batch_dir):
                shutil.rmtree(batch_dir)
        except Exception:
            pass
