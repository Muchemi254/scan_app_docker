from app.tasks.worker import extract_receipt_batch_task

# Mock data
user_id = "test-user-123"
task_id = "test-task-456"
images = [("aW1hZ2UtZGF0YQ==", "image/jpeg")]

print("Dispatching task...")
extract_receipt_batch_task.delay(user_id, task_id, images)
print("Task dispatched.")
