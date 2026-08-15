"""
Unit tests for image_service.process_image passthrough + re-encode paths.

process_image() must reuse already-optimized, upright, small JPEGs verbatim
(zero generation loss) so feeding an image that was previously exported or
compressed does not soften the text further and degrade AI extraction. Anything
else — oversized, non-JPEG, or EXIF-rotated — takes the normalize+encode path.
"""

import io

from PIL import Image

from app.services.image_service import MAX_DIMENSION, process_image
from tests.helpers import make_jpeg_bytes


def test_small_upright_jpeg_passthrough_unchanged():
    data = make_jpeg_bytes(width=640, height=480)
    processed, mime = process_image(data, "image/jpeg")
    assert mime == "image/jpeg"
    assert processed == data, "already-optimized JPEG must be stored as-is (no re-encode)"


def test_large_image_is_resized_and_reencoded():
    data = make_jpeg_bytes(width=MAX_DIMENSION * 2, height=MAX_DIMENSION * 2, color=(200, 30, 30))
    processed, mime = process_image(data, "image/jpeg")
    assert mime == "image/jpeg"
    assert processed != data, "oversized image must be re-encoded/downscaled"
    with Image.open(io.BytesIO(processed)) as img:
        assert img.width <= MAX_DIMENSION and img.height <= MAX_DIMENSION


def test_rotated_jpeg_is_transposed_not_passthrough():
    buf = io.BytesIO()
    img = Image.new("RGB", (200, 120), (10, 10, 200))
    exif = Image.Exif()
    exif[0x0112] = 6  # orientation: rotate 90 CW
    img.save(buf, format="JPEG", exif=exif)
    data = buf.getvalue()

    processed, mime = process_image(data, "image/jpeg")
    assert mime == "image/jpeg"
    assert processed != data, "rotated JPEG must go through exif_transpose"
    with Image.open(io.BytesIO(processed)) as out:
        assert out.size == (120, 200), "EXIF rotation must be baked into the stored copy"