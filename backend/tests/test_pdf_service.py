"""pdf_service unit tests — detect, page count, text layer, page render."""
import io

import pytest
from PIL import Image

from app.services import pdf_service
from tests.helpers import make_jpeg_bytes


def make_text_pdf(pages: int = 2, marker: str = "RECEIPT MARKER") -> bytes:
    """Tiny text-layer PDF via reportlab."""
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for p in range(1, pages + 1):
        c.drawString(72, 720, f"{marker} page {p}")
        c.showPage()
    c.save()
    return buf.getvalue()


def make_scanned_pdf() -> bytes:
    """PDF with no text layer (a rendered image page)."""
    img = Image.open(io.BytesIO(make_jpeg_bytes()))
    buf = io.BytesIO()
    img.save(buf, format="PDF")
    return buf.getvalue()


def test_is_pdf_magic_detect():
    assert pdf_service.is_pdf(b"%PDF-1.7\n...")
    assert not pdf_service.is_pdf(make_jpeg_bytes())
    assert not pdf_service.is_pdf(b"")
    assert not pdf_service.is_pdf(b"not a pdf")


def test_pdf_page_count():
    assert pdf_service.pdf_page_count(make_text_pdf(2)) == 2
    assert pdf_service.pdf_page_count(make_text_pdf(1)) == 1


def test_extract_text_layer():
    text = pdf_service.extract_text(make_text_pdf(2, marker="KES 1,234.56"))
    assert "KES 1,234.56" in text


def test_scanned_pdf_has_no_text_layer():
    assert pdf_service.extract_text(make_scanned_pdf()) == ""


def test_render_first_page_returns_jpeg():
    jpeg = pdf_service.render_first_page(make_text_pdf(2))
    assert jpeg is not None
    assert jpeg[:2] == b"\xff\xd8"  # JPEG magic


def test_render_pdf_pages_bounds_to_max_pages():
    pages = pdf_service.render_pdf_pages(make_text_pdf(5), max_pages=2)
    assert len(pages) == 2
    assert all(p[:2] == b"\xff\xd8" for p in pages)


def test_assert_within_page_cap(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "MAX_PDF_PAGES", 3)
    assert pdf_service.assert_within_page_cap(make_text_pdf(3)) == 3
    with pytest.raises(ValueError, match="maximum supported is 3"):
        pdf_service.assert_within_page_cap(make_text_pdf(4))
