"""
Task management API endpoints.

Endpoints:
POST   /api/v1/users/{userId}/tasks                   - Create task
GET    /api/v1/users/{userId}/tasks                   - List tasks
GET    /api/v1/users/{userId}/tasks/{taskId}          - Get task
PUT    /api/v1/users/{userId}/tasks/{taskId}/progress - Update progress
PUT    /api/v1/users/{userId}/tasks/{taskId}/pause    - Pause task
PUT    /api/v1/users/{userId}/tasks/{taskId}/resume   - Resume task
GET    /api/v1/users/{userId}/tasks/active            - Get active tasks
DELETE /api/v1/users/{userId}/tasks/{taskId}          - Delete task
"""

import logging
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, status, Query
from app.core.security import get_current_user_id
from app.schemas.task import (
    Task, TaskCreate, TaskList, TaskStatus, TaskProgressUpdate
)
from app.services.task_service import TaskService

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/users",
    tags=["tasks"],
)


def verify_user_access(user_id: str, current_user_id: str):
    """Verify multi-tenant access."""
    if user_id != current_user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied"
        )


@router.post("/{user_id}/tasks")
async def create_task(
    user_id: str,
    task: TaskCreate,
    current_user_id: str = Depends(get_current_user_id)
) -> dict:
    """Create a new task."""
    verify_user_access(user_id, current_user_id)

    try:
        task_id = await TaskService.create_task(
            user_id=user_id,
            task_type=task.task_type,
            batch_title=task.batch_title,
            total_items=task.total_items,
            metadata=task.metadata
        )
        return {"task_id": task_id}

    except Exception as e:
        logger.error(f"Failed to create task: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


@router.get("/{user_id}/tasks")
async def list_tasks(
    user_id: str,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    status: Optional[TaskStatus] = None,
    current_user_id: str = Depends(get_current_user_id)
) -> TaskList:
    """List user's tasks."""
    verify_user_access(user_id, current_user_id)

    try:
        tasks, total = await TaskService.list_tasks(
            user_id=user_id,
            skip=skip,
            limit=limit,
            status=status
        )
        return TaskList(items=tasks, total=total, skip=skip, limit=limit)

    except Exception as e:
        logger.error(f"Failed to list tasks: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


@router.get("/{user_id}/tasks/active")
async def get_active_tasks(
    user_id: str,
    current_user_id: str = Depends(get_current_user_id)
) -> list[Task]:
    """Get all active tasks."""
    verify_user_access(user_id, current_user_id)

    try:
        tasks = await TaskService.get_active_tasks(user_id)
        return tasks

    except Exception as e:
        logger.error(f"Failed to get active tasks: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


@router.get("/{user_id}/tasks/{task_id}")
async def get_task(
    user_id: str,
    task_id: str,
    current_user_id: str = Depends(get_current_user_id)
) -> Task:
    """Get task details."""
    verify_user_access(user_id, current_user_id)

    try:
        task = await TaskService.get_task(user_id, task_id)
        if not task:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Task not found"
            )
        return task

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get task: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


@router.put("/{user_id}/tasks/{task_id}/progress")
async def update_progress(
    user_id: str,
    task_id: str,
    update: TaskProgressUpdate,
    current_user_id: str = Depends(get_current_user_id)
) -> dict:
    """Update task progress."""
    verify_user_access(user_id, current_user_id)

    try:
        await TaskService.update_progress(user_id, task_id, update)
        return {"status": "ok"}

    except Exception as e:
        logger.error(f"Failed to update progress: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


@router.put("/{user_id}/tasks/{task_id}/pause")
async def pause_task(
    user_id: str,
    task_id: str,
    current_user_id: str = Depends(get_current_user_id)
) -> dict:
    """Pause a task."""
    verify_user_access(user_id, current_user_id)

    try:
        await TaskService.pause_task(user_id, task_id)
        return {"status": "paused"}

    except Exception as e:
        logger.error(f"Failed to pause task: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


@router.put("/{user_id}/tasks/{task_id}/resume")
async def resume_task(
    user_id: str,
    task_id: str,
    current_user_id: str = Depends(get_current_user_id)
) -> dict:
    """Resume a paused task."""
    verify_user_access(user_id, current_user_id)

    try:
        await TaskService.resume_task(user_id, task_id)
        return {"status": "resumed"}

    except Exception as e:
        logger.error(f"Failed to resume task: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )


@router.delete("/{user_id}/tasks/{task_id}")
async def delete_task(
    user_id: str,
    task_id: str,
    current_user_id: str = Depends(get_current_user_id)
) -> dict:
    """Delete a task."""
    verify_user_access(user_id, current_user_id)

    try:
        await TaskService.delete_task(user_id, task_id)
        return {"status": "deleted"}

    except Exception as e:
        logger.error(f"Failed to delete task: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )
