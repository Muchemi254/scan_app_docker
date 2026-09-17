"""Multi-image receipts: several images combined into one multi-page PDF.

A receipt that spans more than one photo (e.g. a long receipt captured in
parts) is uploaded as several images; the server combines them, in order,
into one PDF so it is stored/extracted as ONE receipt.
"""
import pytest

from app.schemas.receipt import ReceiptCreate
from tests.helpers import (
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    create_user_via_admin,
    login,
    make_jpeg_bytes,
)


def test_images_to_pdf_page_order():
    from app.services.pdf_service import images_to_pdf, pdf_page_count

    images = [
        make_jpeg_bytes(color=(255, 0, 0)),
        make_jpeg_bytes(color=(0, 255, 0)),
        make_jpeg_bytes(color=(0, 0, 255)),
        make_jpeg_bytes(color=(10, 10, 10)),
        make_jpeg_bytes(color=(200, 200, 200)),
    ]
    pdf = images_to_pdf(images)
    assert pdf[:5] == b"%PDF-"
    assert pdf_page_count(pdf) == 5


async def _new_user(client, suffix):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    user = await create_user_via_admin(
        client, admin_headers, f"multi_{suffix}@pytest.local", "testpass123"
    )
    headers, _, _ = await login(client, f"multi_{suffix}@pytest.local", "testpass123")
    return user, headers


@pytest.mark.asyncio
async def test_create_receipt_with_multiple_images(client):
    user, headers = await _new_user(client, "create")
    uid = user["uid"]

    resp = await client.post(
        f"/api/v1/users/{uid}/receipts",
        data={"receipt_data": '{"supplier": "Multi Co", "totalAmount": "10.00", "receiptDate": "08/25/2026", "status": "needs_review"}'},
        files=[
            ("files", ("p1.jpg", make_jpeg_bytes(), "image/jpeg")),
            ("files", ("p2.jpg", make_jpeg_bytes(color=(10, 20, 30)), "image/jpeg")),
            ("files", ("p3.jpg", make_jpeg_bytes(color=(50, 60, 70)), "image/jpeg")),
        ],
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["fileType"] == "application/pdf"
    assert body["pdfPageCount"] == 3
    assert body["imageUrl"]

    # Served as a real 3-page PDF
    from app.services.database_service import read_pdf
    from app.services.pdf_service import pdf_page_count

    raw = read_pdf(body["id"])
    assert raw is not None
    assert pdf_page_count(raw) == 3


@pytest.mark.asyncio
async def test_single_file_still_works(client):
    user, headers = await _new_user(client, "single")
    uid = user["uid"]

    resp = await client.post(
        f"/api/v1/users/{uid}/receipts",
        data={"receipt_data": '{"supplier": "Single Co", "totalAmount": "5.00", "receiptDate": "08/25/2026", "status": "needs_review"}'},
        files={"file": ("one.jpg", make_jpeg_bytes(), "image/jpeg")},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    assert resp.json()["fileType"] == "image/jpeg"


@pytest.mark.asyncio
async def test_extract_multiple_images_uses_pdf(client, monkeypatch):
    user, headers = await _new_user(client, "extract")
    uid = user["uid"]

    captured = {}

    async def fake_extract(base64_data, mime_type, user_id, industry_id=None):
        captured["mime"] = mime_type
        return ReceiptCreate.model_validate(
            {"supplier": "MAP CO", "totalAmount": "1.00", "receiptDate": "08/25/2026", "status": "needs_review"}
        )

    monkeypatch.setattr("app.api.receipts.extract_receipt_data", fake_extract)

    resp = await client.post(
        f"/api/v1/users/{uid}/receipts/extract",
        files=[
            ("files", ("a.jpg", make_jpeg_bytes(), "image/jpeg")),
            ("files", ("b.jpg", make_jpeg_bytes(color=(1, 2, 3)), "image/jpeg")),
        ],
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    assert captured["mime"] == "application/pdf", "multiple images must be combined into a PDF for extraction"


@pytest.mark.asyncio
async def test_update_receipt_with_multiple_images(client):
    user, headers = await _new_user(client, "update")
    uid = user["uid"]

    create = await client.post(
        f"/api/v1/users/{uid}/receipts",
        data={"receipt_data": '{"supplier": "Upd Co", "totalAmount": "10.00", "receiptDate": "08/25/2026", "status": "needs_review"}'},
        headers=headers,
    )
    rid = create.json()["id"]

    resp = await client.put(
        f"/api/v1/users/{uid}/receipts/{rid}",
        data={"receipt_data": '{"supplier": "Upd Co"}'},
        files=[
            ("files", ("x.jpg", make_jpeg_bytes(), "image/jpeg")),
            ("files", ("y.jpg", make_jpeg_bytes(color=(9, 9, 9)), "image/jpeg")),
        ],
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["fileType"] == "application/pdf"
    assert resp.json()["pdfPageCount"] == 2


@pytest.mark.asyncio
async def test_batch_process_combines_grouped_images(client, monkeypatch):
    """Two files sharing a group id become ONE prepared PDF item; the other
    file is its own receipt."""
    user, headers = await _new_user(client, "batch")
    uid = user["uid"]

    names = ["a.jpg", "b.jpg", "c.jpg"]
    created = await client.post(
        f"/api/v1/users/{uid}/batches",
        json={"batchTitle": "Combine", "filenames": names},
        headers=headers,
    )
    assert created.status_code == 201, created.text
    batch_id = created.json()["batchId"]

    resp = await client.post(
        f"/api/v1/users/{uid}/batches/{batch_id}/process",
        files=[
            ("files", ("a.jpg", make_jpeg_bytes(), "image/jpeg")),
            ("files", ("b.jpg", make_jpeg_bytes(color=(3, 3, 3)), "image/jpeg")),
            ("files", ("c.jpg", make_jpeg_bytes(color=(7, 7, 7)), "image/jpeg")),
        ],
        data={"groups": "[0, 0, 1]"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["prepared"] == 2, resp.text

    batch = (await client.get(f"/api/v1/users/{uid}/batches/{batch_id}", headers=headers)).json()
    by_idx = {i["index"]: i for i in batch["items"]}
    # Item 0 is the combined two-image PDF
    assert by_idx[0]["status"] == "prepared"
    assert by_idx[0]["mime"] == "application/pdf"
    # Item 1 was folded into item 0
    assert by_idx[1]["status"] == "duplicate"
    # Item 2 is a normal single image
    assert by_idx[2]["status"] == "prepared"
    assert by_idx[2]["mime"] == "image/jpeg"
