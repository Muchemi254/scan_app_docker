import logging
import asyncio
import os
import base64
import shutil
from app.core.celery_app import celery_app
from app.services.gemini import extract_receipt_data, extract_receipt_batch
from app.services.task_service import TaskService
from app.services.image_service import BATCH_CHUNK_SIZE
from app.schemas.task import TaskStatus, TaskProgressUpdate

logger = logging.getLogger(__name__)


@celery_app.task(name="tasks.extract_receipt")
def extract_receipt_task(user_id: str, task_id: str, image_base64: str, mime_type: str):
    return asyncio.run(_extract_receipt_sync(user_id, task_id, image_base64, mime_type))


async def _extract_receipt_sync(user_id: str, task_id: str, image_base64: str, mime_type: str):
    try:
        await TaskService.update_progress(user_id, task_id, TaskProgressUpdate(
            status=TaskStatus.PROCESSING,
            percentage=50,
            message="Processing receipt..."
        ))

        result = await extract_receipt_data(image_base64, mime_type, user_id)

        await TaskService.add_task_result(user_id, task_id, "receipt", result.model_dump())
        await TaskService.update_progress(user_id, task_id, TaskProgressUpdate(
            status=TaskStatus.COMPLETED,
            percentage=100,
            message="Extraction complete"
        ))

    except Exception as e:
        logger.error(f"Task {task_id} failed: {e}")
        await TaskService.update_progress(user_id, task_id, TaskProgressUpdate(
            status=TaskStatus.FAILED,
            percentage=0,
            message=str(e),
            error=str(e)
        ))


@celery_app.task(name="tasks.extract_receipt_batch")
def extract_receipt_batch_task(user_id: str, task_id: str, batch_dir: str,
                                image_entries: list, provider: str = "gemini"):
    """
    Celery task for batch receipt extraction.

    image_entries: list of {"filename": str, "mime": str}
    batch_dir: temp directory on disk holding the processed JPEGs
    """
    return asyncio.run(_extract_receipt_batch_sync(user_id, task_id, batch_dir, image_entries, provider))


async def _extract_receipt_batch_sync(user_id: str, task_id: str, batch_dir: str,
                                       image_entries: list, provider: str = "gemini"):
    try:
        from app.services.gemini import get_gemini_config
        api_key, model_id, active_provider = await get_gemini_config(user_id)

        total_items = len(image_entries)
        await TaskService.update_progress(user_id, task_id, TaskProgressUpdate(
            status=TaskStatus.PROCESSING,
            percentage=10,
            message=f"Processing batch of {total_items} with {active_provider}..."
        ))

        # ── Process in sub-batches to limit memory per Gemini call ──
        all_results = []
        for chunk_start in range(0, total_items, BATCH_CHUNK_SIZE):
            chunk = image_entries[chunk_start : chunk_start + BATCH_CHUNK_SIZE]
            pct = 10 + int(80 * chunk_start / total_items)
            await TaskService.update_progress(user_id, task_id, TaskProgressUpdate(
                status=TaskStatus.PROCESSING,
                percentage=pct,
                message=f"Extracting {chunk_start + 1}–{min(chunk_start + len(chunk), total_items)} of {total_items}..."
            ))

            # Encode images from disk to base64 (one at a time, discarded after chunk)
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
            all_results.extend(chunk_results)

        # Add results and mark complete
        for i, res in enumerate(all_results):
            if res:
                await TaskService.add_task_result(user_id, task_id, f"item_{i}", res.model_dump())

        await TaskService.update_progress(user_id, task_id, TaskProgressUpdate(
            status=TaskStatus.COMPLETED,
            percentage=100,
            message="Batch extraction complete"
        ))

    except Exception as e:
        logger.error(f"Batch task {task_id} failed: {e}")
        await TaskService.update_progress(user_id, task_id, TaskProgressUpdate(
            status=TaskStatus.FAILED,
            percentage=0,
            message=str(e),
            error=str(e)
        ))
    finally:
        # Clean up temp batch directory
        try:
            if os.path.isdir(batch_dir):
                shutil.rmtree(batch_dir)
        except Exception:
            pass
