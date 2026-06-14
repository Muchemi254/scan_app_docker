import logging
import asyncio
import os
import base64
import shutil
import uuid
from app.core.celery_app import celery_app
from app.services.gemini import extract_receipt_data, extract_receipt_batch
from app.services.task_service import TaskService
from app.services.image_service import BATCH_CHUNK_SIZE, process_image, generate_thumbnail
from app.services.data_adapter import DataService
from app.services.audit_service import AuditService
from app.schemas.task import TaskStatus, TaskProgressUpdate

logger = logging.getLogger(__name__)


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
    return False


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

        # ── Extract via Gemini in sub-batches ──
        all_results = []
        for chunk_start in range(0, total_items, BATCH_CHUNK_SIZE):
            chunk = image_entries[chunk_start : chunk_start + BATCH_CHUNK_SIZE]
            pct = 10 + int(40 * chunk_start / total_items)
            await TaskService.update_progress(user_id, task_id, TaskProgressUpdate(
                status=TaskStatus.PROCESSING, percentage=pct,
                message=f"AI: {chunk_start + 1}–{min(chunk_start + len(chunk), total_items)} of {total_items}..."
            ))

            b64_images = []
            for entry in chunk:
                fpath = os.path.join(batch_dir, entry["filename"])
                with open(fpath, "rb") as f:
                    img_bytes = f.read()
                b64 = base64.standard_b64encode(img_bytes).decode()
                b64_images.append((b64, entry.get("mime", "image/jpeg")))

            chunk_results = await extract_receipt_batch(
                b64_images, api_key, model_id, active_provider, user_id=user_id
            )
            # Pair each result with its original image bytes for saving
            for idx_in_chunk, res in enumerate(chunk_results):
                img_bytes = None
                if res is not None:
                    fpath = os.path.join(batch_dir, chunk[idx_in_chunk]["filename"])
                    with open(fpath, "rb") as f:
                        img_bytes = f.read()
                all_results.append((img_bytes, res))

        # ── Save receipts + images + audit ──
        for i, (img_bytes, res) in enumerate(all_results):
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
                has_missing = _has_missing_fields(data)

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
