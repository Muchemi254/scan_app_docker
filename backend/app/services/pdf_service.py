"""
PDF receipt helpers.

- ``is_pdf`` — magic-byte detection (``%PDF-``).
- ``pdf_page_count`` — page count via pypdf.
- ``extract_text`` — text-layer extraction (pypdf); returns "" for scanned
  PDFs with no text layer.
- ``render_pdf_pages`` — page 1..N rendered to JPEG bytes (pdf2image +
  poppler-utils); used to give vision providers per-page images and to build
  the page-1 thumbnail.
- ``render_first_page`` — page 1 as JPEG (thumbnail pipeline).

The page cap (``settings.MAX_PDF_PAGES``) is enforced by the callers at
upload AND at worker/dispatch time.
"""
import io
import logging
from typing import List, Optional

from app.core.config import settings

logger = logging.getLogger(__name__)

_PDF_MAGIC = b"%PDF-"


def is_pdf(data: bytes) -> bool:
    """True if the bytes start with the PDF magic marker."""
    return bool(data) and data[:5] == _PDF_MAGIC


def pdf_page_count(pdf_bytes: bytes) -> int:
    """Number of pages in the PDF.  Raises ValueError if unreadable."""
    from pypdf import PdfReader

    try:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        return len(reader.pages)
    except Exception as e:
        raise ValueError(f"Could not read PDF: {e}") from e


def extract_text(pdf_bytes: bytes) -> str:
    """Extract the embedded text layer of a PDF.

    Returns "" for scanned/image-only PDFs (no text layer) so callers can
    distinguish "text available" from "needs a vision provider".
    """
    from pypdf import PdfReader

    try:
        reader = PdfReader(io.BytesIO(pdf_bytes))
        parts = []
        for page in reader.pages:
            try:
                text = page.extract_text() or ""
            except Exception:
                text = ""
            parts.append(text)
        return "\n".join(parts).strip()
    except Exception as e:
        raise ValueError(f"Could not read PDF text layer: {e}") from e


def _convert_pdf_to_images(pdf_bytes: bytes, max_pages: Optional[int] = None) -> List[bytes]:
    """Render PDF pages to JPEG bytes via poppler (pdf2image).

    ``max_pages`` bounds the number of rendered pages (page cap).
    Raises ValueError if poppler is missing or rendering fails.
    """
    from pdf2image import convert_from_bytes

    try:
        images = convert_from_bytes(
            pdf_bytes,
            dpi=150,
            fmt="jpeg",
            first_page=1,
            last_page=max_pages,  # None → all pages
        )
    except Exception as e:
        # poppler-utils missing or corrupt PDF
        raise ValueError(f"Could not render PDF: {e}") from e

    out = []
    for img in images:
        buf = io.BytesIO()
        img.save(buf, format="JPEG", quality=88)
        out.append(buf.getvalue())
    return out


def render_pdf_pages(pdf_bytes: bytes, max_pages: Optional[int] = None) -> List[bytes]:
    """Render page 1..N of the PDF to JPEG bytes (page order preserved)."""
    return _convert_pdf_to_images(pdf_bytes, max_pages=max_pages)


def render_first_page(pdf_bytes: bytes) -> Optional[bytes]:
    """Render just page 1 to JPEG (thumbnail).  None on failure."""
    try:
        pages = render_pdf_pages(pdf_bytes, max_pages=1)
        return pages[0] if pages else None
    except Exception as e:
        logger.warning("PDF page-1 render failed: %s", e)
        return None


def assert_within_page_cap(pdf_bytes: bytes, cap: Optional[int] = None) -> int:
    """Return the page count, raising ValueError if over the cap."""
    cap = settings.MAX_PDF_PAGES if cap is None else cap
    count = pdf_page_count(pdf_bytes)
    if cap and count > cap:
        raise ValueError(
            f"PDF has {count} pages — maximum supported is {cap}. "
            "Split the document or upload pages separately."
        )
    return count


def images_to_pdf(image_bytes_list: List[bytes]) -> bytes:
    """Combine one or more images into a single multi-page PDF.

    One image becomes one PDF page, in the given order — this is how a
    receipt that spans several photos is stored as ONE receipt (the PDF
    multi-page pipeline then feeds every page to the AI as one document).
    Raises ValueError if the list is empty or an image can't be decoded.
    """
    from PIL import Image

    if not image_bytes_list:
        raise ValueError("No images to combine")

    pages = []
    for idx, raw in enumerate(image_bytes_list):
        try:
            img = Image.open(io.BytesIO(raw))
            if img.mode not in ("RGB",):
                img = img.convert("RGB")
            pages.append(img)
        except Exception as e:
            raise ValueError(f"Could not read image {idx + 1} for PDF combine: {e}") from e

    buf = io.BytesIO()
    try:
        pages[0].save(
            buf,
            format="PDF",
            save_all=True,
            append_images=pages[1:],
            resolution=150.0,
        )
    except Exception as e:
        raise ValueError(f"Could not build combined PDF: {e}") from e
    return buf.getvalue()


def merge_pdfs(first: bytes, second: bytes) -> bytes:
    """Append ``second``'s pages after ``first``'s (lossless pypdf merge).

    Used to add pages to a receipt that already holds a multi-page PDF.
    Raises ValueError if either PDF is unreadable.
    """
    from pypdf import PdfReader, PdfWriter

    writer = PdfWriter()
    try:
        for part in (first, second):
            writer.append(PdfReader(io.BytesIO(part)))
        buf = io.BytesIO()
        writer.write(buf)
    except Exception as e:
        raise ValueError(f"Could not merge PDFs: {e}") from e
    return buf.getvalue()
