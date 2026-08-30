"""PDF provider conversion matrix + batch grouping (mocked AI calls)."""
import io
import json

import pytest

from app.services import gemini
from app.services.gemini import extract_receipt_batch, pdf_to_provider_parts, _image_parts
from app.services.pdf_service import render_pdf_pages


def make_pdf(pages: int = 2) -> bytes:
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for p in range(1, pages + 1):
        c.drawString(72, 720, f"Invoice page {p} total 99.00")
        c.showPage()
    c.save()
    return buf.getvalue()


def make_scanned_pdf() -> bytes:
    from PIL import Image
    from tests.helpers import make_jpeg_bytes

    img = Image.open(io.BytesIO(make_jpeg_bytes()))
    buf = io.BytesIO()
    img.save(buf, format="PDF")
    return buf.getvalue()


def _qwen_parts(pdf_bytes: bytes) -> list[dict]:
    return pdf_to_provider_parts(pdf_bytes, "qwen", label="Receipt index 0")


def test_gemini_gets_inline_pdf_part():
    parts = pdf_to_provider_parts(make_pdf(2), "gemini", label="PDF document")
    assert "PDF document" in parts[0]["text"] and "(2 pages)" in parts[0]["text"]
    inline = [p for p in parts if p.get("mime_type") == "application/pdf"]
    assert len(inline) == 1
    assert inline[0]["data"]  # base64 payload present


def test_qwen_gets_one_image_part_per_page():
    parts = _qwen_parts(make_pdf(2))
    images = [p for p in parts if p.get("type") == "image_url"]
    assert len(images) == 2
    assert all(p["image_url"]["url"].startswith("data:image/jpeg;base64,") for p in images)
    labels = " ".join(p.get("text", "") for p in parts)
    assert "page 1 of 2" in labels and "page 2 of 2" in labels


def test_openrouter_uses_same_path_as_qwen():
    parts = pdf_to_provider_parts(make_pdf(1), "openrouter")
    images = [p for p in parts if p.get("type") == "image_url"]
    assert len(images) == 1


def test_deepseek_gets_text_layer():
    parts = pdf_to_provider_parts(make_pdf(2), "deepseek", label="Receipt index 0")
    text_part = parts[0]
    assert text_part["type"] == "text"
    assert "99.00" in text_part["text"]
    assert "Receipt index 0" in text_part["text"]


def test_deepseek_rejects_scanned_pdf():
    with pytest.raises(ValueError, match="vision provider"):
        pdf_to_provider_parts(make_scanned_pdf(), "deepseek")


def test_page_cap_raises_over_limit(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "MAX_PDF_PAGES", 1)
    with pytest.raises(ValueError, match="maximum supported is 1"):
        _qwen_parts(make_pdf(3))


def _receipt_dict(supplier, invoice, image_index):
    return {
        "supplier": supplier,
        "totalAmount": "99.00",
        "taxAmount": "9.00",
        "receiptDate": "08/14/2026",
        "category": "Office",
        "invoiceNumber": invoice,
        "items": [],
        "imageIndex": image_index,
    }


@pytest.mark.asyncio
async def test_batch_grouping_one_receipt_per_pdf(monkeypatch):
    captured = {}

    async def fake_qwen(api_key, model_id, prompt, content=None, thinking_mode=False, max_tokens=None):
        captured["content"] = content
        receipts = [
            _receipt_dict("ACME", "INV-1", 0),
            _receipt_dict("BETA", "INV-2", 1),
        ]
        return json.dumps({"receipts": receipts})

    monkeypatch.setattr("app.services.gemini.call_qwen_api", fake_qwen)

    files = [
        pdf_to_provider_parts(make_pdf(2), "qwen", label="Receipt index 0"),
        pdf_to_provider_parts(make_pdf(1), "qwen", label="Receipt index 1"),
    ]
    results = await extract_receipt_batch(files, "sk-test", "qwen3-vl-flash", "qwen")

    assert len(results) == 2
    assert results[0].supplier == "ACME"
    assert results[1].supplier == "BETA"
    # Both PDFs' page images were sent in one call, grouped per receipt
    images = [p for p in captured["content"] if p.get("type") == "image_url"]
    assert len(images) == 3  # 2 pages + 1 page


@pytest.mark.asyncio
async def test_batch_image_parts_still_work(monkeypatch):
    async def fake_gemini(api_key, model_id, content, generation_config=None):
        return type("R", (), {"text": json.dumps({"receipts": [
            _receipt_dict("ONE", "INV-A", 0),
        ]})})()

    monkeypatch.setattr("app.services.gemini._gemini_generate_content", fake_gemini)

    files = [
        [{"mime_type": "image/jpeg", "data": "aGVsbG8="}],
    ]
    results = await extract_receipt_batch(files, "sk", "gemini-3-flash-preview", "gemini")
    assert len(results) == 1
    assert results[0].supplier == "ONE"


def test_image_parts_label_shape():
    parts = _image_parts("aGVsbG8=", "image/jpeg", "qwen", label="Receipt index 3")
    assert parts[0] == {"type": "text", "text": "Receipt index 3"}
    assert parts[1]["type"] == "image_url"
    gemini_parts = _image_parts("aGVsbG8=", "image/jpeg", "gemini", label="Receipt index 3")
    assert gemini_parts[0] == {"text": "Receipt index 3"}
    assert gemini_parts[1]["mime_type"] == "image/jpeg"
