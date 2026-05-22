"""
Task management service — PostgreSQL backend.
"""

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any

from app.core.database import get_pool
from app.schemas.task import Task, TaskStatus, TaskType, TaskProgressUpdate

logger = logging.getLogger(__name__)


def _row_to_task(row) -> Task:
    """Convert a PostgreSQL row to a Task Pydantic model."""
    d = dict(row)
    d["id"] = str(d["id"])
    d["task_type"] = d["task_type"]
    d["status"] = d["status"]
    d["metadata"] = d.get("metadata") or {}
    d["results"] = d.get("results") or {}
    return Task(**d)


class TaskService:

    @staticmethod
    async def create_task(
        user_id: str,
        task_type: TaskType,
        batch_title: str,
        total_items: int,
        metadata: Dict[str, Any] = None
    ) -> str:
        task_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc)

        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO tasks (id, user_id, task_type, batch_title, status,
                    total_items, completed_items, current_step, total_steps,
                    percentage, message, error, metadata, results,
                    created_at, updated_at, started_at, completed_at)
                VALUES ($1, $2, $3, $4, $5, $6, 0, 0, $7, 0, $8, NULL, $9::jsonb, '{}'::jsonb,
                        $10, $10, NULL, NULL)
                """,
                task_id, user_id, task_type.value, batch_title,
                TaskStatus.QUEUED.value, total_items, total_items,
                "Task created, waiting to start",
                json.dumps(metadata or {}, default=str),
                now,
            )
        logger.info("Created task %s for user %s", task_id, user_id)
        return task_id

    @staticmethod
    async def get_task(user_id: str, task_id: str) -> Optional[Task]:
        pool = await get_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM tasks WHERE id = $1 AND user_id = $2",
                task_id, user_id,
            )
            if not row:
                return None
            return _row_to_task(row)

    @staticmethod
    async def list_tasks(
        user_id: str,
        skip: int = 0,
        limit: int = 50,
        status: Optional[TaskStatus] = None
    ) -> tuple:
        pool = await get_pool()
        async with pool.acquire() as conn:
            params = [user_id]
            conditions = ["user_id = $1"]
            p = 2

            if status:
                params.append(status.value)
                conditions.append(f"status = ${p}")
                p += 1

            where = " AND ".join(conditions)
            params.extend([limit, skip])

            rows = await conn.fetch(
                f"""
                SELECT *, COUNT(*) OVER() AS full_count
                FROM tasks
                WHERE {where}
                ORDER BY created_at DESC
                LIMIT ${p} OFFSET ${p + 1}
                """,
                *params,
            )
            total = rows[0]["full_count"] if rows else 0
            tasks = [_row_to_task(r) for r in rows]
            return tasks, total

    @staticmethod
    async def update_progress(
        user_id: str,
        task_id: str,
        update: TaskProgressUpdate
    ) -> bool:
        now = datetime.now(timezone.utc)

        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                # Set started_at if transitioning to PROCESSING
                if update.status == TaskStatus.PROCESSING:
                    await conn.execute(
                        """
                        UPDATE tasks SET started_at = COALESCE(started_at, $3)
                        WHERE id = $1 AND user_id = $2 AND started_at IS NULL
                        """,
                        task_id, user_id, now,
                    )

                completed_at = now if update.status in (TaskStatus.COMPLETED, TaskStatus.FAILED) else None

                result = await conn.execute(
                    """
                    UPDATE tasks SET
                        status = $3, current_step = $4, total_steps = $5,
                        percentage = $6, message = $7, error = $8,
                        completed_items = $9, updated_at = $10
                        || CASE WHEN $11::timestamptz IS NOT NULL THEN ', completed_at = $11' ELSE '' END
                    WHERE id = $1 AND user_id = $2
                    """,
                    task_id, user_id,
                    update.status.value, update.current_step, update.total_steps,
                    update.percentage, update.message, update.error,
                    update.completed_items, now,
                    f", completed_at = '{completed_at.isoformat()}'::timestamptz" if completed_at else "",
                )
                return True

    @staticmethod
    async def add_task_result(
        user_id: str,
        task_id: str,
        result_key: str,
        result_data: Any
    ) -> bool:
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE tasks
                SET results = results || $3::jsonb,
                    updated_at = $4
                WHERE id = $1 AND user_id = $2
                """,
                task_id, user_id,
                json.dumps({result_key: result_data}, default=str),
                datetime.now(timezone.utc),
            )
            return True

    @staticmethod
    async def get_active_tasks(user_id: str) -> List[Task]:
        pool = await get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT * FROM tasks
                WHERE user_id = $1 AND status IN ('queued', 'processing')
                ORDER BY created_at DESC
                """,
                user_id,
            )
            return [_row_to_task(r) for r in rows]

    @staticmethod
    async def pause_task(user_id: str, task_id: str) -> bool:
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE tasks SET status = 'paused', updated_at = $3
                WHERE id = $1 AND user_id = $2
                """,
                task_id, user_id, datetime.now(timezone.utc),
            )
            logger.info("Paused task %s", task_id)
            return True

    @staticmethod
    async def resume_task(user_id: str, task_id: str) -> bool:
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                UPDATE tasks SET status = 'processing', updated_at = $3
                WHERE id = $1 AND user_id = $2
                """,
                task_id, user_id, datetime.now(timezone.utc),
            )
            logger.info("Resumed task %s", task_id)
            return True

    @staticmethod
    async def delete_task(user_id: str, task_id: str) -> bool:
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                "DELETE FROM tasks WHERE id = $1 AND user_id = $2",
                task_id, user_id,
            )
            logger.info("Deleted task %s", task_id)
            return True
