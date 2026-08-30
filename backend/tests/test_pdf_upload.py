"""End-to-end PDF upload/serve/delete via the API (mocked AI extraction)."""
import io

import pytest

from app.schemas.receipt import ReceiptCreate
from tests.helpers import ADMIN_EMAIL, ADMIN_PASSWORD, create_user_via_admin, login, make_jpeg_bytes


def make_text_pdf(pages: int = 2) -> bytes:
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for p in range(1, pages + 1):
        c.drawString(72, 720, f"PDF receipt page {p}")
        c.showPage()
    c.save()
    return buf.getvalue()


def sample_receipt():
    return {
        "supplier": "ACME PDF",
        "totalAmount": "1500.00",
        "taxAmount": "200.00",
        "receiptDate": "08/25/2026",
        "category": "Office",
        "items": [{"name": "Paper", "quantity": 1, "price": "1500.00", "tax": "200.00", "isZeroRated": False}],
    }


async def _new_user(client):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    user = await create_user_via_admin(client, admin_headers, "pdf_user@pytest.local", "testpass123")
    headers, _, _ = await login(client, "pdf_user@pytest.local", "testpass123")
    return user, headers


@pytest.mark.asyncio
async def test_extract_pdf_returns_extraction(client, monkeypatch):
    user, headers = await _new_user(client)

    async def fake_extract(base64_data, mime_type, user_id):
        assert mime_type == "application/pdf"
        return ReceiptCreate.model_validate(sample_receipt())

    monkeypatch.setattr("app.api.receipts.extract_receipt_data", fake_extract)

    resp = await client.post(
        f"/api/v1/users/{user['uid']}/receipts/extract",
        headers=headers,
        files={"file": ("invoice.pdf", make_text_pdf(2), "application/pdf")},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["supplier"] == "ACME PDF"


@pytest.mark.asyncio
async def test_post_receipt_stores_pdf_and_serves(client):
    from app.core.config import settings

    user, headers = await _new_user(client)
    uid = user["uid"]

    resp = await client.post(
        f"/api/v1/users/{uid}/receipts",
        data={"receipt_data": '{"supplier": "PDF Co", "totalAmount": "100.00", "receiptDate": "08/25/2026", "status": "needs_review"}'},
        files={"file": ("doc.pdf", make_text_pdf(2), "application/pdf")},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    rid = resp.json()["id"]
    assert resp.json()["fileType"] == "application/pdf"
    assert resp.json()["pdfPageCount"] == 2

    # Raw file served as application/pdf with nosniff + inline
    full = await client.get(f"/api/images/cached?url=%2Freceipt-images%2F{rid}")
    assert full.status_code == 200, full.text
    assert full.headers["content-type"] == "application/pdf"
    assert full.headers["x-content-type-options"] == "nosniff"

    # Thumbnail served as image/jpeg
    thumb = await client.get(f"/api/images/cached?url=%2Freceipt-images%2F{rid}&thumb=1")
    assert thumb.status_code == 200, thumb.text
    assert thumb.headers["content-type"] == "image/jpeg"

    # File on disk is {id}.pdf
    import os
    assert os.path.exists(os.path.join(settings.IMAGE_STORAGE_DIR, f"{rid}.pdf"))
    assert os.path.exists(os.path.join(settings.IMAGE_STORAGE_DIR, f"{rid}_thumb.jpg"))


@pytest.mark.asyncio
async def test_delete_receipt_removes_pdf_too(client):
    from app.core.config import settings

    user, headers = await _new_user(client)
    uid = user["uid"]

    resp = await client.post(
        f"/api/v1/users/{uid}/receipts",
        data={"receipt_data": '{"supplier": "Del Co", "totalAmount": "50.00", "receiptDate": "08/25/2026", "status": "needs_review"}'},
        files={"file": ("del.pdf", make_text_pdf(1), "application/pdf")},
        headers=headers,
    )
    rid = resp.json()["id"]

    from app.services.database_service import delete_receipt_images
    delete_receipt_images(rid)

    import os
    assert not os.path.exists(os.path.join(settings.IMAGE_STORAGE_DIR, f"{rid}.pdf"))


@pytest.mark.asyncio
async def test_pdf_page_cap_rejected_at_upload(client, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "MAX_PDF_PAGES", 1)
    user, headers = await _new_user(client)

    resp = await client.post(
        f"/api/v1/users/{user['uid']}/receipts/extract",
        headers=headers,
        files={"file": ("big.pdf", make_text_pdf(2), "application/pdf")},
    )
    assert resp.status_code == 400, resp.text
    assert "maximum supported is 1" in resp.text


@pytest.mark.asyncio
async def test_pdf_size_cap_rejected(client, monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "MAX_UPLOAD_SIZE", 100)
    user, headers = await _new_user(client)

    resp = await client.post(
        f"/api/v1/users/{user['uid']}/receipts/extract",
        headers=headers,
        files={"file": ("big.pdf", make_text_pdf(2), "application/pdf")},
    )
    assert resp.status_code == 413, resp.text


@pytest.mark.asyncio
async def test_jpeg_upload_still_works(client, monkeypatch):
    user, headers = await _new_user(client)

    async def fake_extract(base64_data, mime_type, user_id):
        assert mime_type == "image/jpeg"
        return ReceiptCreate.model_validate(sample_receipt())

    monkeypatch.setattr("app.api.receipts.extract_receipt_data", fake_extract)

    resp = await client.post(
        f"/api/v1/users/{user['uid']}/receipts/extract",
        headers=headers,
        files={"file": ("r.jpg", make_jpeg_bytes(), "image/jpeg")},
    )
    assert resp.status_code == 200, resp.text


@pytest.mark.asyncio
async def test_list_and_search_has_pdf_filter(client):
    user, headers = await _new_user(client)
    uid = user["uid"]

    # One PDF + one image receipt
    pdf = await client.post(
        f"/api/v1/users/{uid}/receipts",
        data={"receipt_data": '{"supplier": "Pdf Co", "totalAmount": "10.00", "receiptDate": "08/25/2026", "status": "needs_review"}'},
        files={"file": ("a.pdf", make_text_pdf(1), "application/pdf")},
        headers=headers,
    )
    assert pdf.status_code == 201, pdf.text
    img = await client.post(
        f"/api/v1/users/{uid}/receipts",
        data={"receipt_data": '{"supplier": "Img Co", "totalAmount": "20.00", "receiptDate": "08/25/2026", "status": "needs_review"}'},
        files={"file": ("b.jpg", make_jpeg_bytes(), "image/jpeg")},
        headers=headers,
    )
    assert img.status_code == 201, img.text

    pdfs = (await client.get(f"/api/v1/users/{uid}/receipts", params={"hasPdf": "true"}, headers=headers)).json()
    assert [i["supplier"] for i in pdfs["items"]] == ["Pdf Co"]
    non_pdfs = (await client.get(f"/api/v1/users/{uid}/receipts", params={"hasPdf": "false"}, headers=headers)).json()
    assert [i["supplier"] for i in non_pdfs["items"]] == ["Img Co"]

    s = (await client.get(
        f"/api/v1/users/{uid}/receipts/search",
        params={"q": "Co", "hasPdf": "true"},
        headers=headers,
    )).json()
    assert s["total"] == 1
    assert s["results"][0]["supplier"] == "Pdf Co"
