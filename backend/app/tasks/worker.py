import logging
import asyncio
from app.core.celery_app import celery_app
from app.services.gemini import extract_receipt_data, extract_receipt_batch
from app.services.task_service import TaskService
from app.schemas.task import TaskStatus, TaskProgressUpdate

logger = logging.getLogger(__name__)

@celery_app.task(name="tasks.extract_receipt")
def extract_receipt_task(user_id: str, task_id: str, image_base64: str, mime_type: str):
    """Celery task for single receipt extraction."""
    return asyncio.run(_extract_receipt_sync(user_id, task_id, image_base64, mime_type))

async def _extract_receipt_sync(user_id: str, task_id: str, image_base64: str, mime_type: str):
    try:
        # Update status to processing
        await TaskService.update_progress(user_id, task_id, TaskProgressUpdate(
            status=TaskStatus.PROCESSING,
            percentage=50,
            message="Processing receipt..."
        ))

        # Perform extraction
        result = await extract_receipt_data(image_base64, mime_type, user_id)
        
        # Add result and mark complete
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
def extract_receipt_batch_task(user_id: str, task_id: str, images: list[tuple[str, str]], provider: str = "gemini"):
    """Celery task for batch receipt extraction."""
    return asyncio.run(_extract_receipt_batch_sync(user_id, task_id, images, provider))

async def _extract_receipt_batch_sync(user_id: str, task_id: str, images: list[tuple[str, str]], provider: str = "gemini"):
    try:
        from app.services.gemini import get_gemini_config
        api_key, model_id, active_provider = await get_gemini_config(user_id)

        total_items = len(images)
        await TaskService.update_progress(user_id, task_id, TaskProgressUpdate(
            status=TaskStatus.PROCESSING,
            percentage=10,
            message=f"Processing batch of {total_items} with {active_provider}..."
        ))

        # Perform extraction using fetched creds
        results = await extract_receipt_batch(images, api_key, model_id, active_provider, user_id=user_id)
        
        # Add results and mark complete
        
        # Add results and mark complete
        for i, res in enumerate(results):
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
