"""
Regression tests for TaskService persistence against Postgres.

Catches SQL that breaks the batch-progress lifecycle (e.g. the old string-
concatenation `updated_at = $10 || CASE ...` which caused asyncpg
DatatypeMismatchError on `completed_at`).
"""

import pytest

from app.schemas.task import TaskProgressUpdate, TaskStatus, TaskType
from tests.helpers import ADMIN_EMAIL, ADMIN_PASSWORD, create_user_via_admin, login


@pytest.fixture
async def user_id(client):
    from app.core.database import init_pool, close_pool
    await init_pool()
    try:
        admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
        user = await create_user_via_admin(client, admin_headers, "tasky@pytest.local", "taskypass123")
        yield user["uid"]
    finally:
        await close_pool()


async def test_task_progress_lifecycle(user_id):
    from app.services.task_service import TaskService

    task_id = await TaskService.create_task(
        user_id, TaskType.SCAN_BATCH, "Regression batch", total_items=3
    )

    created = await TaskService.get_task(user_id, task_id)
    assert created is not None
    assert created.status == TaskStatus.QUEUED
    assert created.completed_at is None

    ok = await TaskService.update_progress(
        user_id,
        task_id,
        TaskProgressUpdate(
            status=TaskStatus.PROCESSING,
            current_step=0,
            total_steps=3,
            percentage=0,
            message="Starting",
        ),
    )
    assert ok

    ok = await TaskService.update_progress(
        user_id,
        task_id,
        TaskProgressUpdate(
            status=TaskStatus.COMPLETED,
            current_step=3,
            total_steps=3,
            percentage=100,
            message="Done",
            completed_items=3,
        ),
    )
    assert ok

    done = await TaskService.get_task(user_id, task_id)
    assert done.completed_at is not None
    assert done.status == TaskStatus.COMPLETED
    assert done.completed_items == 3
    assert done.percentage == 100