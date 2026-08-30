"""PDF batch flows — staging prep, dispatch mime preservation, worker chunks."""
import asyncio
import io
import os

import pytest

from app.schemas.receipt import ReceiptCreate
from tests.helpers import (
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    create_user_via_admin,
    login,
    make_jpeg_bytes,
)


def make_text_pdf(pages: int = 2) -> bytes:
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for p in range(1, pages + 1):
        c.drawString(72, 720, f"Batch PDF page {p}")
        c.showPage()
    c.save()
    return buf.getvalue()


def _receipt_dict(supplier="PDF Batch Co"):
    return {
        "supplier": supplier,
        "totalAmount": "250.00",
        "taxAmount": "30.00",
        "receiptDate": "08/25/2026",
        "category": "Office",
        "items": [],
    }


async def _new_user(client):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    user = await create_user_via_admin(client, admin_headers, "pdfbatch@pytest.local", "testpass123")
    headers, _, _ = await login(client, "pdfbatch@pytest.local", "testpass123")
    return user, headers


@pytest.mark.asyncio
async def test_staging_batch_prep_mixed_pdf_and_image(client):
    user, headers = await _new_user(client)
    uid = user["uid"]

    resp = await client.post(
        f"/api/v1/users/{uid}/batches",
        json={"batchTitle": "Mixed", "filenames": ["a.jpg", "b.pdf"]},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    batch_id = resp.json()["batchId"]

    resp = await client.post(
        f"/api/v1/users/{uid}/batches/{batch_id}/process",
        headers=headers,
        files=[
            ("files", ("a.jpg", make_jpeg_bytes(), "image/jpeg")),
            ("files", ("b.pdf", make_text_pdf(2), "application/pdf")),
        ],
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["prepared"] == 2

    batch = (await client.get(f"/api/v1/users/{uid}/batches/{batch_id}", headers=headers)).json()
    items = {i["index"]: i for i in batch["items"]}
    assert items[0]["mime"] == "image/jpeg"
    assert items[0]["filename"].endswith(".jpg")
    assert items[1]["mime"] == "application/pdf"
    assert items[1]["filename"].endswith(".pdf")


@pytest.mark.asyncio
async def test_dispatch_preserves_recorded_mime_for_pdf(client, monkeypatch):
    user, headers = await _new_user(client)
    uid = user["uid"]

    resp = await client.post(
        f"/api/v1/users/{uid}/batches",
        json={"batchTitle": "Dispatch", "filenames": ["b.pdf"]},
        headers=headers,
    )
    batch_id = resp.json()["batchId"]

    await client.post(
        f"/api/v1/users/{uid}/batches/{batch_id}/process",
        headers=headers,
        files=[("files", ("b.pdf", make_text_pdf(2), "application/pdf"))],
    )

    class Recorder:
        def __init__(self):
            self.calls = []

        def delay(self, *args, **kwargs):
            self.calls.append((args, kwargs))

    rec = Recorder()
    monkeypatch.setattr("app.api.batches.process_batch_task", rec)

    resp = await client.post(
        f"/api/v1/users/{uid}/batches/{batch_id}/dispatch",
        json={"all": True},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text

    assert len(rec.calls) == 1
    args, _ = rec.calls[0]
    entries = args[3]
    assert len(entries) == 1
    assert entries[0]["mime"] == "application/pdf"
    assert entries[0]["filename"].endswith(".pdf")


@pytest.mark.asyncio
async def test_worker_chunk_converts_pdf_to_per_page_parts(monkeypatch, tmp_path):
    from app.tasks.worker import _extract_one_chunk

    batch_dir = str(tmp_path)
    pdf_bytes = make_text_pdf(2)
    with open(os.path.join(batch_dir, "0000.pdf"), "wb") as f:
        f.write(pdf_bytes)

    captured = {}

    async def fake_batch(files, api_key, model_id, provider, user_id=None):
        captured["files"] = files
        return [ReceiptCreate.model_validate(_receipt_dict())]

    monkeypatch.setattr("app.tasks.worker.extract_receipt_batch", fake_batch)

    chunk = [{"index": 0, "filename": "0000.pdf", "mime": "application/pdf", "sha256": None}]
    raw_list, results = await _extract_one_chunk(chunk, batch_dir, "sk", "m", "qwen", "uid")

    assert len(raw_list) == 1 and raw_list[0] == pdf_bytes
    assert results[0].supplier == "PDF Batch Co"
    parts = captured["files"][0]
    images = [p for p in parts if p.get("type") == "image_url"]
    assert len(images) == 2  # one per page


@pytest.mark.asyncio
async def test_worker_persists_pdf_receipt(client):
    from app.core.config import settings
    from app.services.database_service import delete_receipt_images
    from app.tasks.worker import _persist_one_item

    user, headers = await _new_user(client)
    uid = user["uid"]

    pdf_bytes = make_text_pdf(2)
    receipt = ReceiptCreate.model_validate(_receipt_dict())

    events = []

    async def on_update(*args):
        events.append(args)

    async def on_result(*args):
        events.append(args)

    entry = {"index": 0, "filename": "0000.pdf", "mime": "application/pdf", "sha256": None}
    await _persist_one_item(uid, entry, pdf_bytes, receipt, "PDF Batch", on_update, on_result)

    # Receipt saved with PDF metadata
    from app.services.data_adapter import DataService
    latest = None
    rows = await DataService.list_receipts(uid, limit=50)
    for r in rows[0]:
        if r.get("fileType") == "application/pdf":
            latest = r
    assert latest is not None
    assert latest["pdfPageCount"] == 2
    assert latest["imageUrl"]

    rid = latest["id"]
    assert os.path.exists(os.path.join(settings.IMAGE_STORAGE_DIR, f"{rid}.pdf"))
    assert os.path.exists(os.path.join(settings.IMAGE_STORAGE_DIR, f"{rid}_thumb.jpg"))

    delete_receipt_images(rid)
    assert not os.path.exists(os.path.join(settings.IMAGE_STORAGE_DIR, f"{rid}.pdf"))
