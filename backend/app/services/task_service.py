"""
Task management service for tracking processing progress.

Handles:
- Task creation and lifecycle
- Progress tracking
- Task resumption
- History management
"""

import logging
import uuid
from typing import Optional, List, Dict, Any
from datetime import datetime
from app.schemas.task import Task, TaskStatus, TaskType, TaskProgressUpdate
from app.services.firebase_service import get_db

logger = logging.getLogger(__name__)


class TaskService:
    """Service for managing task progress and lifecycle."""

    @staticmethod
    async def create_task(
        user_id: str,
        task_type: TaskType,
        batch_title: str,
        total_items: int,
        metadata: Dict[str, Any] = None
    ) -> str:
        """
        Create a new task.

        Args:
            user_id: User ID
            task_type: Type of task
            batch_title: Title of the batch being processed
            total_items: Total number of items to process
            metadata: Additional metadata

        Returns:
            Task ID
        """
        try:
            task_id = str(uuid.uuid4())
            now = datetime.utcnow()

            task_data = {
                "id": task_id,
                "user_id": user_id,
                "task_type": task_type.value,
                "batch_title": batch_title,
                "status": TaskStatus.QUEUED.value,
                "total_items": total_items,
                "completed_items": 0,
                "current_step": 0,
                "total_steps": total_items,
                "percentage": 0,
                "message": "Task created, waiting to start",
                "error": None,
                "metadata": metadata or {},
                "created_at": now,
                "updated_at": now,
                "started_at": None,
                "completed_at": None,
                "results": {}
            }

            db = get_db()
            db.document(f"users/{user_id}/tasks/{task_id}").set(task_data)

            logger.info(f"Created task {task_id} for user {user_id}")
            return task_id

        except Exception as e:
            logger.error(f"Failed to create task: {e}")
            raise

    @staticmethod
    async def get_task(user_id: str, task_id: str) -> Optional[Task]:
        """Get task details."""
        try:
            db = get_db()
            doc = db.document(f"users/{user_id}/tasks/{task_id}").get()

            if not doc.exists:
                return None

            data = doc.to_dict()
            return Task(**data)

        except Exception as e:
            logger.error(f"Failed to get task: {e}")
            raise

    @staticmethod
    async def list_tasks(
        user_id: str,
        skip: int = 0,
        limit: int = 50,
        status: Optional[TaskStatus] = None
    ) -> tuple[List[Task], int]:
        """
        List user's tasks with filtering.

        Args:
            user_id: User ID
            skip: Number to skip
            limit: Max results
            status: Filter by status

        Returns:
            Tuple of (tasks, total count)
        """
        try:
            db = get_db()
            query = db.collection(f"users/{user_id}/tasks")

            if status:
                query = query.where("status", "==", status.value)

            # Order by creation date descending
            query = query.order_by("created_at", direction="DESCENDING")

            # Get total
            total = len(list(query.stream()))

            # Get paginated results
            tasks = []
            for doc in query.offset(skip).limit(limit).stream():
                tasks.append(Task(**doc.to_dict()))

            return tasks, total

        except Exception as e:
            logger.error(f"Failed to list tasks: {e}")
            raise

    @staticmethod
    async def update_progress(
        user_id: str,
        task_id: str,
        update: TaskProgressUpdate
    ) -> bool:
        """Update task progress."""
        try:
            db = get_db()
            now = datetime.utcnow()

            update_data = {
                "status": update.status.value,
                "current_step": update.current_step,
                "total_steps": update.total_steps,
                "percentage": update.percentage,
                "message": update.message,
                "error": update.error,
                "completed_items": update.completed_items,
                "updated_at": now,
            }

            # Set started_at when transitioning from QUEUED to PROCESSING
            if update.status == TaskStatus.PROCESSING:
                doc = db.document(f"users/{user_id}/tasks/{task_id}").get()
                if doc.exists:
                    data = doc.to_dict()
                    if not data.get("started_at"):
                        update_data["started_at"] = now

            # Set completed_at when task completes or fails
            if update.status in (TaskStatus.COMPLETED, TaskStatus.FAILED):
                update_data["completed_at"] = now

            db.document(f"users/{user_id}/tasks/{task_id}").update(update_data)

            logger.info(f"Updated task {task_id} progress: {update.percentage}%")
            return True

        except Exception as e:
            logger.error(f"Failed to update task progress: {e}")
            raise

    @staticmethod
    async def add_task_result(
        user_id: str,
        task_id: str,
        result_key: str,
        result_data: Any
    ) -> bool:
        """Add result data to task."""
        try:
            db = get_db()

            # Get current results
            doc = db.document(f"users/{user_id}/tasks/{task_id}").get()
            if not doc.exists:
                raise ValueError("Task not found")

            results = doc.to_dict().get("results", {})
            results[result_key] = result_data

            db.document(f"users/{user_id}/tasks/{task_id}").update({
                "results": results,
                "updated_at": datetime.utcnow()
            })

            return True

        except Exception as e:
            logger.error(f"Failed to add task result: {e}")
            raise

    @staticmethod
    async def get_active_tasks(user_id: str) -> List[Task]:
        """Get all active (non-completed) tasks."""
        try:
            db = get_db()
            query = db.collection(f"users/{user_id}/tasks").where(
                "status", "in", [TaskStatus.QUEUED.value, TaskStatus.PROCESSING.value]
            )

            tasks = []
            for doc in query.stream():
                tasks.append(Task(**doc.to_dict()))

            return tasks

        except Exception as e:
            logger.error(f"Failed to get active tasks: {e}")
            return []

    @staticmethod
    async def pause_task(user_id: str, task_id: str) -> bool:
        """Pause a task."""
        try:
            db = get_db()
            db.document(f"users/{user_id}/tasks/{task_id}").update({
                "status": TaskStatus.PAUSED.value,
                "updated_at": datetime.utcnow()
            })

            logger.info(f"Paused task {task_id}")
            return True

        except Exception as e:
            logger.error(f"Failed to pause task: {e}")
            raise

    @staticmethod
    async def resume_task(user_id: str, task_id: str) -> bool:
        """Resume a paused task."""
        try:
            db = get_db()
            db.document(f"users/{user_id}/tasks/{task_id}").update({
                "status": TaskStatus.PROCESSING.value,
                "updated_at": datetime.utcnow()
            })

            logger.info(f"Resumed task {task_id}")
            return True

        except Exception as e:
            logger.error(f"Failed to resume task: {e}")
            raise

    @staticmethod
    async def delete_task(user_id: str, task_id: str) -> bool:
        """Delete a task."""
        try:
            db = get_db()
            db.document(f"users/{user_id}/tasks/{task_id}").delete()

            logger.info(f"Deleted task {task_id}")
            return True

        except Exception as e:
            logger.error(f"Failed to delete task: {e}")
            raise
