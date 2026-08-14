"""
Integration test for the background batch-extraction engine (the Celery
worker's core): parallel extraction → persistence → image-SHA dedup.

The batch engine is driven directly (`_run_batch_extraction`) in the test
process — no Celery broker, no Redis — with the AI provider mocked.
This is the same code path the `tasks.extract_receipt_batch` task runs.
"""

import hashlib
import os
import shutil

from app.schemas.receipt import ReceiptCreate

from tests.helpers import (
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    create_user_via_admin,
    login,
    make_jpeg_bytes,
    sample_receipt,
)

BATCH_DIR = "/tmp/scanapp_test_batch"


def _write_batch_dir(entries_count: int):
    """Write `entries_count` distinct JPEGs and return batch entries."""
    if os.path.isdir(BATCH_DIR):
        shutil.rmtree(BATCH_DIR)
    os.makedirs(BATCH_DIR, exist_ok=True)

    entries = []
    for i in range(entries_count):
        # Distinct bytes per entry so each image has a unique SHA256.
        img = make_jpeg_bytes(width=160 + i, color=(190 + i, 200, 220))
        fname = f"{i:04d}.jpg"
        with open(os.path.join(BATCH_DIR, fname), "wb") as f:
            f.write(img)
        sha256 = hashlib.sha256(img).hexdigest()
        entries.append({"filename": fname, "mime": "image/jpeg", "index": i, "sha256": sha256})
    return entries


async def test_batch_engine_persists_and_dedups(client, monkeypatch):
    from app.core.database import init_pool, close_pool
    from app.services.data_adapter import DataService
    from app.tasks import worker

    # Create a user through the real auth API so the pipeline is complete.
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    user = await create_user_via_admin(client, admin_headers, "carol@pytest.local", "carol-pass")
    user_id = user["uid"]

    # Mock the AI call — returns a fresh receipt per image.
    async def fake_extract_batch(images, api_key, model_id, provider, user_id=None):
        return [
            ReceiptCreate.model_validate(sample_receipt(invoice=f"INV-{i}"))
            for i in range(len(images))
        ]

    monkeypatch.setattr("app.tasks.worker.extract_receipt_batch", fake_extract_batch)

    await init_pool()
    try:
        # ── Run 1: 3 distinct images → 3 receipts persisted ──
        entries = _write_batch_dir(3)
        saved = []

        async def on_item_result(idx, data):
            saved.append((idx, data))

        await worker._run_batch_extraction(
            user_id,
            BATCH_DIR,
            entries,
            batch_title="Offline pipeline batch",
            on_item_result=on_item_result,
        )

        receipts, total = await DataService.list_receipts(user_id)
        assert total == 3, f"expected 3 receipts, got {total}"
        assert len(saved) == 3
        assert all(data is not None for _, data in saved)
        assert all(r["batchTitle"] == "Offline pipeline batch" for r in receipts)
        assert all(data["status"] == "needs_review" for _, data in saved), \
            "every AI-extracted receipt must be flagged for review, even with all fields present"

        # ── Run 2: same distinct images again → dedup links, no copies ──
        entries = _write_batch_dir(3)
        saved2 = []

        async def on_item_result_dup(idx, data):
            saved2.append((idx, data))

        await worker._run_batch_extraction(
            user_id,
            BATCH_DIR,
            entries,
            batch_title="Offline pipeline batch",
            on_item_result=on_item_result_dup,
        )

        receipts, total = await DataService.list_receipts(user_id)
        assert total == 3, "dedup failed — duplicate receipts created"
        # Duplicates return no saved data (they link to existing receipts)
        assert all(data is None for _, data in saved2)
    finally:
        await close_pool()