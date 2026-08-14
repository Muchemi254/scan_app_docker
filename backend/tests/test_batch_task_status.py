"""
Regression tests for the Celery batch-task wrapper (`_extract_receipt_batch_sync`):
a fully-failed batch must end FAILED (never report "receipts saved"), and a
successful batch must end COMPLETED.
"""

import hashlib
import os
import shutil

from app.schemas.task import TaskProgressUpdate, TaskStatus, TaskType
from tests.helpers import (
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    create_user_via_admin,
    login,
    make_jpeg_bytes,
    sample_receipt,
)

BATCH_DIR = "/tmp/scanapp_test_batch_task"


def _entries(count: int):
    if os.path.isdir(BATCH_DIR):
        shutil.rmtree(BATCH_DIR)
    os.makedirs(BATCH_DIR, exist_ok=True)
    entries = []
    for i in range(count):
        img = make_jpeg_bytes(width=170 + i, color=(150 + i, 160, 180))
        fname = f"{i:04d}.jpg"
        with open(os.path.join(BATCH_DIR, fname), "wb") as f:
            f.write(img)
        entries.append({
            "filename": fname,
            "mime": "image/jpeg",
            "index": i,
            "sha256": hashlib.sha256(img).hexdigest(),
        })
    return entries


async def _setup_user(client):
    from app.core.database import close_pool, init_pool
    await init_pool()
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    user = await create_user_via_admin(client, admin_headers, "tasky2@pytest.local", "tasky2pass123")
    return user["uid"]


async def test_batch_task_completed_when_all_saved(client, monkeypatch):
    from app.services.task_service import TaskService
    from app.tasks import worker

    user_id = await _setup_user(client)
    try:
        entries = _entries(2)

        async def fake_extract_batch(images, api_key, model_id, provider, user_id=None):
            from app.schemas.receipt import ReceiptCreate
            return [ReceiptCreate.model_validate(sample_receipt(invoice=f"INV-{i}")) for i in range(len(images))]

        monkeypatch.setattr("app.tasks.worker.extract_receipt_batch", fake_extract_batch)

        task_id = await TaskService.create_task(user_id, TaskType.SCAN_BATCH, "ok batch", len(entries))
        await worker._extract_receipt_batch_sync(user_id, task_id, BATCH_DIR, entries)

        task = await TaskService.get_task(user_id, task_id)
        assert task.status == TaskStatus.COMPLETED
        assert "receipts saved" in task.message
        assert task.completed_at is not None
    finally:
        from app.core.database import close_pool
        await close_pool()


async def test_batch_task_failed_when_ai_fails(client, monkeypatch):
    from app.services.task_service import TaskService
    from app.tasks import worker

    user_id = await _setup_user(client)
    try:
        entries = _entries(2)

        async def broken_extract(images, api_key, model_id, provider, user_id=None):
            raise Exception("Gemini quota exceeded — prepayment credits depleted")

        monkeypatch.setattr("app.tasks.worker.extract_receipt_batch", broken_extract)

        task_id = await TaskService.create_task(user_id, TaskType.SCAN_BATCH, "fail batch", len(entries))
        await worker._extract_receipt_batch_sync(user_id, task_id, BATCH_DIR, entries)

        task = await TaskService.get_task(user_id, task_id)
        assert task.status == TaskStatus.FAILED
        assert "no receipts saved" in (task.message or "").lower()
        assert task.completed_at is not None
    finally:
        from app.core.database import close_pool
        await close_pool()