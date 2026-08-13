"""
Image processing service.

Two-stage pipeline so display quality and AI token cost are decoupled:
- process_image()  → high-quality JPEG used for storage + human review.
- prepare_for_ai() → downscaled-on-the-fly copy sent to Gemini.

Benefits:
- HEIC → JPEG so browsers can display stored images
- Stored images stay sharp enough to read line-item values by eye
- AI input is still 1024px / q=75, so Gemini token cost is unchanged
- Generate 400px thumbnail: instant preview in gallery/review views
"""

import io
import logging
import os
from typing import Tuple, Optional
from PIL import Image

logger = logging.getLogger(__name__)

# ── Storage / display pipeline (what humans see in the UI) ────────────────
# 1600px + quality 82 + progressive encoding lands around 180–280 KB per
# receipt — about 2–3× the old 95 KB pipeline but legible at zoom. Anything
# bigger blows up disk usage with little visual gain for text-heavy receipts.
MAX_DIMENSION = 1600
JPEG_QUALITY = 82

# ── AI pipeline (what Gemini sees; token cost depends on this) ────────────
MAX_DIMENSION_AI = 1024 # px — matches Gemini's effective vision resolution
JPEG_QUALITY_AI = 75    # good balance for OCR-grade extraction

THUMB_DIMENSION = 400   # px — quick preview in lists
THUMB_QUALITY = 60      # smaller file for thumbnails

# Number of images per Gemini batch call — keep small to limit
# memory per API request and isolate chunk failures.
BATCH_CHUNK_SIZE = 10

# Max concurrent Gemini calls during batch extraction.
# Tune based on your Gemini tier (free: 2, pay-as-you-go: 5-10).
MAX_AI_CONCURRENCY = int(os.getenv("MAX_AI_CONCURRENCY", "4"))


def _open_and_normalise(file_data: bytes, content_type: str):
    """Open an image, handle HEIC, EXIF rotate, and convert to RGB."""
    if content_type.lower() in ("image/heic", "image/heif"):
        try:
            import pillow_heif
            pillow_heif.register_heif_opener()
        except ImportError:
            raise ValueError(
                "HEIC images are not supported on this server "
                "(pillow-heif is not installed)."
            )

    img = Image.open(io.BytesIO(file_data))

    try:
        from PIL import ImageOps
        img = ImageOps.exif_transpose(img)
    except Exception:
        pass

    if img.mode not in ("RGB",):
        img = img.convert("RGB")

    return img


def _encode_jpeg(img, quality: int) -> bytes:
    output = io.BytesIO()
    # progressive=True saves ~5–10% on text-heavy images and also renders
    # incrementally in the browser, which feels faster on slower links.
    img.save(output, format="JPEG", quality=quality, optimize=True, progressive=True)
    return output.getvalue()


# Valid image magic bytes (file header signatures)
_VALID_MAGIC_BYTES = {
    b"\xff\xd8\xff": "image/jpeg",
    b"\x89PNG\r\n\x1a\n": "image/png",
    b"RIFF": "image/webp",
    b"\x00\x00\x00": "image/heic",  # ISO BMFF (ftyp at offset 4)
}

def _detect_image_format(file_data: bytes) -> Optional[str]:
    """Detect image format from magic bytes, ignoring Content-Type header."""
    if len(file_data) < 12:
        return None
    for magic, fmt in _VALID_MAGIC_BYTES.items():
        if file_data.startswith(magic):
            return fmt
    # HEIC/HEIF: check ftyp box at offset 4
    if file_data[4:8] == b"ftyp":
        return "image/heic"
    return None


def process_image(file_data: bytes, content_type: str) -> Tuple[bytes, str]:
    """
    Normalise an uploaded image for storage and AI processing.

    Validates format by magic bytes (not Content-Type header).
    """
    # Validate by magic bytes
    detected = _detect_image_format(file_data)
    if not detected:
        raise ValueError("Unsupported image format — must be JPEG, PNG, WebP, or HEIC")
    content_type = detected  # Trust magic bytes, not client header

    try:
        with _open_and_normalise(file_data, content_type) as img:
            if img.width > MAX_DIMENSION or img.height > MAX_DIMENSION:
                img.thumbnail((MAX_DIMENSION, MAX_DIMENSION), Image.LANCZOS)

            processed = _encode_jpeg(img, JPEG_QUALITY)
            logger.info(
                f"Image processed: {len(file_data)//1024} KB → {len(processed)//1024} KB "
                f"({img.size[0]}×{img.size[1]}px)"
            )
            return processed, "image/jpeg"

    except ValueError:
        raise
    except Exception as e:
        logger.error(f"Image processing failed: {e}")
        raise ValueError(f"Image processing failed: {e}")


def prepare_for_ai(jpeg_bytes: bytes) -> bytes:
    """Downscale a stored display JPEG to the AI-input dimensions.

    Called immediately before base64-encoding for Gemini. Keeps the per-call
    token count identical to the pre-split pipeline (1024px / q=75) even
    though we now store a higher-quality copy on disk.
    """
    try:
        with Image.open(io.BytesIO(jpeg_bytes)) as img:
            if img.mode != "RGB":
                img = img.convert("RGB")
            # If the image is already at-or-below the AI ceiling, only re-encode
            # when the source was likely high-quality (saves CPU on small images).
            needs_resize = img.width > MAX_DIMENSION_AI or img.height > MAX_DIMENSION_AI
            if not needs_resize and len(jpeg_bytes) <= 250 * 1024:
                return jpeg_bytes
            if needs_resize:
                img.thumbnail((MAX_DIMENSION_AI, MAX_DIMENSION_AI), Image.LANCZOS)
            return _encode_jpeg(img, JPEG_QUALITY_AI)
    except Exception as e:
        # Don't break extraction if shrink fails — send the stored bytes.
        logger.warning(f"prepare_for_ai failed, sending stored image as-is: {e}")
        return jpeg_bytes


def generate_thumbnail(file_data: bytes, content_type: str) -> bytes | None:
    """
    Generate a small JPEG thumbnail for instant preview.

    Only generates a thumbnail if the image would meaningfully shrink
    (width or height > THUMB_DIMENSION).  Otherwise returns None so the
    caller can just use the full image for both.

    Returns:
        JPEG bytes or None (when image is already small enough)
    """
    try:
        with _open_and_normalise(file_data, content_type) as img:
            if img.width <= THUMB_DIMENSION and img.height <= THUMB_DIMENSION:
                return None

            img.thumbnail((THUMB_DIMENSION, THUMB_DIMENSION), Image.LANCZOS)
            thumb = _encode_jpeg(img, THUMB_QUALITY)
            logger.info(f"Thumbnail: {img.size[0]}×{img.size[1]}px, {len(thumb)//1024} KB")
            return thumb

    except Exception as e:
        logger.warning(f"Thumbnail generation failed (non-fatal): {e}")
        return None


def has_missing_fields(data: dict) -> bool:
    """Check if receipt data has critical missing fields (mirrors frontend logic)."""
    required = [
        "supplier", "receiptDate", "totalAmount", "taxAmount",
        "category", "invoiceNumber", "kraPin", "cuInvoice",
    ]
    for field in required:
        val = data.get(field)
        if not val or str(val).strip() == "" or val == "N/A":
            return True
    items = data.get("items") or []
    if not items:
        return True
    for item in items:
        if not item.get("name") or not item.get("quantity"):
            return True
        if not item.get("isZeroRated") and not item.get("tax"):
            return True
    return False
