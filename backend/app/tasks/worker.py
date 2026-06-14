import logging
import asyncio
import os
import base64
import shutil
import uuid
from app.core.celery_app import celery_app
from app.services.gemini import extract_receipt_data, extract_receipt_batch
from app.services.task_service import TaskService
from app.services.image_service import BATCH_CHUNK_SIZE, MAX_AI_CONCURRENCY, process_image, generate_thumbnail, has_missing_fields
from app.services.data_adapter import DataService
from app.services.audit_service import AuditService
from app.schemas.task import TaskStatus, TaskProgressUpdate

logger = logging.getLogger(__name__)


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


# ── Batch task — extracts, saves receipts + images + audit ───────────────────

@celery_app.task(name="tasks.extract_receipt_batch")
def extract_receipt_batch_task(user_id: str, task_id: str, batch_dir: str,
                                image_entries: list, provider: str = "gemini"):
    return asyncio.run(_extract_receipt_batch_sync(user_id, task_id, batch_dir, image_entries, provider))


async def _extract_receipt_batch_sync(user_id: str, task_id: str, batch_dir: str,
                                       image_entries: list, provider: str = "gemini"):
    # Cache imports for this async context
    try:
        from app.core.config import settings
    except Exception:
        settings = None

    try:
        from app.services.gemini import get_gemini_config
        api_key, model_id, active_provider = await get_gemini_config(user_id)

        total_items = len(image_entries)
        await TaskService.update_progress(user_id, task_id, TaskProgressUpdate(
            status=TaskStatus.PROCESSING, percentage=5,
            message=f"Starting batch of {total_items} with {active_provider}..."
        ))

        # ── Extract via Gemini — parallel chunks with concurrency cap ──
        all_results = [None] * total_items  # pre-allocated for index-based insertion

        async def process_chunk(chunk_start, chunk):
            """Process one chunk: encode images, call Gemini, return results with global index."""
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
            return [(chunk_start + i, img_bytes_list[i] if chunk_results[i] is not None else None, chunk_results[i])
                    for i in range(len(chunk_results))]

        sem = asyncio.Semaphore(MAX_AI_CONCURRENCY)

        async def bounded(chunk_start, chunk):
            async with sem:
                return await process_chunk(chunk_start, chunk)

        tasks = []
        for chunk_start in range(0, total_items, BATCH_CHUNK_SIZE):
            chunk = image_entries[chunk_start : chunk_start + BATCH_CHUNK_SIZE]
            tasks.append(bounded(chunk_start, chunk))

        await TaskService.update_progress(user_id, task_id, TaskProgressUpdate(
            status=TaskStatus.PROCESSING, percentage=10,
            message=f"AI: {total_items} images in {len(tasks)} chunks ({MAX_AI_CONCURRENCY} parallel)..."
        ))
        chunk_results = await asyncio.gather(*tasks)
        await TaskService.update_progress(user_id, task_id, TaskProgressUpdate(
            status=TaskStatus.PROCESSING, percentage=40,
            message="AI extraction done — saving receipts..."
        ))

        # Flatten into indexed list: all_results[global_index] = (img_bytes, receipt)
        for results in chunk_results:
            for global_idx, img_bytes, receipt in results:
                all_results[global_idx] = (img_bytes, receipt)

        # ── Save receipts + images + audit ──
        for i in range(total_items):
            item = all_results[i]
            if item is None:
                await TaskService.add_task_result(user_id, task_id, f"item_{i}", None)
                continue

            img_bytes, res = item
            if res is None:
                await TaskService.add_task_result(user_id, task_id, f"item_{i}", None)
                continue

            pct = 50 + int(50 * i / total_items)
            await TaskService.update_progress(user_id, task_id, TaskProgressUpdate(
                status=TaskStatus.PROCESSING, percentage=pct,
                message=f"Saving {i + 1} of {total_items}..."
            ))

            try:
                data = res.model_dump(exclude_unset=True)
                data["status"] = "needs_review"
                has_missing = has_missing_fields(data)

                receipt_id = str(uuid.uuid4())

                # Save images
                img_filename = None
                thumb_filename = None
                if img_bytes and settings and settings.USE_POSTGRES:
                    from app.services.database_service import save_image, save_thumbnail
                    img_filename = save_image(receipt_id, img_bytes)
                    thumb = generate_thumbnail(img_bytes, "image/jpeg")
                    thumb_filename = save_thumbnail(receipt_id, thumb) if thumb else None

                # Save receipt to database
                data["id"] = receipt_id
                data["userId"] = user_id
                if settings and settings.USE_POSTGRES:
                    data["image_filename"] = img_filename
                    if thumb_filename:
                        data["thumbnail_filename"] = thumb_filename

                await DataService.create_receipt(user_id, data)
                await AuditService.log_create(user_id, receipt_id, data, user_id)

                # Store saved receipt (with id) in task result for frontend polling
                saved_data = dict(data)
                saved_data["status"] = "needs_review" if has_missing else "processed"
                await TaskService.add_task_result(user_id, task_id, f"item_{i}", saved_data)

            except Exception as item_exc:
                logger.error(f"Batch task {task_id} item {i} save failed: {item_exc}")
                await TaskService.add_task_result(user_id, task_id, f"item_{i}", None)

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


# ── ScannerPage batch processing (migrated from batches.py BackgroundTasks) ──

@celery_app.task(name="tasks.process_batch")
def process_batch_task(user_id: str, batch_id: str, batch_dir: str, entries: list, batch_title: str = ""):
    """
    Process a scanner batch: read JPEGs from disk, extract with Gemini,
    save receipts + images + audit, update per-item Redis status.

    entries: [{"filename", "mime", "orig_filename"}, ...]
    batch_dir: temp directory with pre-processed JPEGs from upload
    """
    import asyncio as _asyncio
    loop = _asyncio.get_event_loop()
    return loop.run_until_complete(_process_batch_sync(user_id, batch_id, batch_dir, entries, batch_title))


async def _process_batch_sync(user_id: str, batch_id: str, batch_dir: str,
                               entries: list, batch_title: str = ""):
    try:
        from app.core.config import settings
        from app.services import batch_service
        from app.services.gemini import get_gemini_config, extract_receipt_batch

        api_key, model_id, active_provider = await get_gemini_config(user_id)

        total_items = len(entries)
        await batch_service.set_batch_status(user_id, batch_id, "processing")
        logger.info(f"Batch {batch_id}: processing {total_items} images for user {user_id}")

        for chunk_start in range(0, total_items, BATCH_CHUNK_SIZE):
            chunk = entries[chunk_start : chunk_start + BATCH_CHUNK_SIZE]
            chunk_indices = list(range(chunk_start, chunk_start + len(chunk)))

            try:
                # Read already-processed JPEGs from disk
                processed_chunk = []
                for idx, entry in zip(chunk_indices, chunk):
                    await batch_service.update_item(user_id, batch_id, idx, "processing", message="Preparing...")
                    fpath = os.path.join(batch_dir, entry["filename"])
                    with open(fpath, "rb") as f:
                        jpeg_bytes = f.read()
                    processed_chunk.append((jpeg_bytes, "image/jpeg", entry.get("orig_filename", entry["filename"])))

                # Call Gemini
                for idx in chunk_indices:
                    await batch_service.update_item(user_id, batch_id, idx, "processing", message="AI batch extraction...")

                ai_input = [
                    (base64.standard_b64encode(p[0]).decode(), p[1])
                    for p in processed_chunk
                ]
                extracted_results = await extract_receipt_batch(ai_input, api_key, model_id, active_provider, user_id=user_id)

                # Save receipts + images + audit
                for idx, result, (p_bytes, p_type, filename) in zip(chunk_indices, extracted_results, processed_chunk):
                    if result is None:
                        await batch_service.update_item(user_id, batch_id, idx, "failed", message="AI failed to extract data")
                        continue

                    try:
                        data = result.model_dump(exclude_unset=True)
                        receipt_status = "needs_review"

                        import uuid as _uuid
                        receipt_id = str(_uuid.uuid4())

                        await batch_service.update_item(user_id, batch_id, idx, "processing", message="Saving images...")
                        thumb = generate_thumbnail(p_bytes, "image/jpeg")

                        if settings.USE_POSTGRES:
                            from app.services.database_service import save_image, save_thumbnail
                            img_filename = save_image(receipt_id, p_bytes)
                            thumb_filename = save_thumbnail(receipt_id, thumb) if thumb else None

                        await batch_service.update_item(user_id, batch_id, idx, "processing", message="Saving to database...")
                        data.update(
                            id=receipt_id, userId=user_id, batchTitle=batch_title,
                            status=receipt_status,
                        )
                        if settings.USE_POSTGRES:
                            data["image_filename"] = img_filename
                            if thumb_filename:
                                data["thumbnail_filename"] = thumb_filename

                        await DataService.create_receipt(user_id, data)
                        await AuditService.log_create(user_id, receipt_id, data, user_id)

                        has_missing = has_missing_fields(data)
                        item_status = "done" if not has_missing else "needs_review"
                        msg = "Saved successfully" if not has_missing else "Missing fields — saved for review"
                        await batch_service.update_item(user_id, batch_id, idx, item_status, receipt_id=receipt_id, message=msg)

                    except Exception as item_exc:
                        logger.error(f"Batch {batch_id} item {idx} failed: {item_exc}")
                        if settings.USE_POSTGRES:
                            from app.services.database_service import delete_receipt_images
                            delete_receipt_images(receipt_id)
                        await batch_service.update_item(user_id, batch_id, idx, "failed", message=str(item_exc)[:200])

            except Exception as chunk_exc:
                logger.error(f"Batch {batch_id} chunk failed: {chunk_exc}")
                for idx in chunk_indices:
                    batch_state = await batch_service.get_batch(user_id, batch_id)
                    if batch_state and batch_state["items"][idx]["status"] == "processing":
                        await batch_service.update_item(user_id, batch_id, idx, "failed", message=f"Chunk error: {str(chunk_exc)[:100]}")

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
