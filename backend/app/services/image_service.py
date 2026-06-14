"""
Image processing service.

Handles HEIC conversion, resizing, and JPEG compression before
storing to Firebase Storage or sending to Gemini Vision.

Benefits:
- HEIC → JPEG so browsers can display stored images
- Resize to 1600x1600 max: fewer tokens for Gemini, faster uploads
- Compress at quality 85: typically 70-90% size reduction
- Generate 400px thumbnail: instant preview in gallery/review views
"""

import io
import logging
from typing import Tuple, Optional
from PIL import Image

logger = logging.getLogger(__name__)

MAX_DIMENSION = 1024  # px — enough for OCR/receipt reading (was 1600, 56% fewer tokens)
THUMB_DIMENSION = 400  # px — quick preview in lists
JPEG_QUALITY = 75      # good balance: readable, ~15% smaller than 85
THUMB_QUALITY = 60     # smaller file for thumbnails

# Number of images per Gemini batch call — keep small to limit
# memory per API request and isolate chunk failures.
BATCH_CHUNK_SIZE = 5


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
    img.save(output, format="JPEG", quality=quality, optimize=True)
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
        img = _open_and_normalise(file_data, content_type)

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
        img = _open_and_normalise(file_data, content_type)

        if img.width <= THUMB_DIMENSION and img.height <= THUMB_DIMENSION:
            return None

        img.thumbnail((THUMB_DIMENSION, THUMB_DIMENSION), Image.LANCZOS)
        thumb = _encode_jpeg(img, THUMB_QUALITY)
        logger.info(f"Thumbnail: {img.size[0]}×{img.size[1]}px, {len(thumb)//1024} KB")
        return thumb

    except Exception as e:
        logger.warning(f"Thumbnail generation failed (non-fatal): {e}")
        return None
