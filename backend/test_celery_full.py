from app.services.task_service import TaskService
from app.schemas.task import TaskType
from app.tasks.worker import extract_receipt_batch_task
import asyncio

# Mock data
user_id = "test-user-123"
images = [("aW1hZ2UtZGF0YQ==", "image/jpeg")]

async def test_full_flow():
    print("Creating task document...")
    task_id = await TaskService.create_task(
        user_id, TaskType.SCAN_BATCH, "Batch Extraction Test", len(images)
    )
    print(f"Task created with ID: {task_id}")

    print("Dispatching task...")
    extract_receipt_batch_task.delay(user_id, task_id, images)
    print("Task dispatched.")

if __name__ == "__main__":
    asyncio.run(test_full_flow())
