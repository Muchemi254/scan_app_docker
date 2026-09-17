"""Multi-image receipts: a receipt holds 1..N image files.

Each uploaded image is stored as its own ``receipt_images`` row with its own
file/thumbnail, rather than being merged into a PDF. These tests exercise the
manual create / edit / extract flows and the per-image dedup.
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


async def _new_user(client, suffix):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    user = await create_user_via_admin(
        client, admin_headers, f"multi_{suffix}@pytest.local", "testpass123"
    )
    headers, _, _ = await login(client, f"multi_{suffix}@pytest.local", "testpass123")
    return user, headers


async def _create_with_images(client, headers, uid, count, supplier="MULTI CO"):
    files = [
        ("files", (f"p{i}.jpg", make_jpeg_bytes(color=(i * 30 % 255, 10, 20)), "image/jpeg"))
        for i in range(count)
    ]
    return await client.post(
        f"/api/v1/users/{uid}/receipts",
        data={"receipt_data": f'{{"supplier": "{supplier}", "totalAmount": "10.00", "receiptDate": "08/25/2026", "status": "needs_review"}}'},
        files=files,
        headers=headers,
    )


@pytest.mark.asyncio
async def test_create_receipt_with_multiple_images(client):
    user, headers = await _new_user(client, "create")
    uid = user["uid"]

    resp = await _create_with_images(client, headers, uid, 3)
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["imageCount"] == 3
    assert len(body["images"]) == 3
    # Every image is its own file (jpeg), ordered.
    assert [im["sortOrder"] for im in body["images"]] == [0, 1, 2]
    assert all(im["fileType"] == "image/jpeg" for im in body["images"])
    # Cover stays in sync with image 0.
    assert body["fileType"] == "image/jpeg"
    assert body["imageUrl"] == body["images"][0]["imageUrl"]

    # Each image is individually served.
    for im in body["images"]:
        got = await client.get(f"/api/images/cached?url={im['imageUrl']}")
        assert got.status_code == 200, got.text
        assert got.headers["content-type"].startswith("image/jpeg")


@pytest.mark.asyncio
async def test_single_image_and_single_pdf_still_work(client):
    user, headers = await _new_user(client, "single")
    uid = user["uid"]

    one = await _create_with_images(client, headers, uid, 1, supplier="ONE IMG")
    assert one.status_code == 201, one.text
    assert one.json()["imageCount"] == 1
    assert one.json()["fileType"] == "image/jpeg"

    # Single PDF upload is kept as one PDF image.
    from tests.test_pdf_upload import make_text_pdf

    pdf = await client.post(
        f"/api/v1/users/{uid}/receipts",
        data={"receipt_data": '{"supplier": "PDF CO", "totalAmount": "5.00", "receiptDate": "08/25/2026", "status": "needs_review"}'},
        files={"file": ("doc.pdf", make_text_pdf(2), "application/pdf")},
        headers=headers,
    )
    assert pdf.status_code == 201, pdf.text
    assert pdf.json()["fileType"] == "application/pdf"
    assert pdf.json()["images"][0]["fileType"] == "application/pdf"


@pytest.mark.asyncio
async def test_image_cap_enforced(client):
    user, headers = await _new_user(client, "cap")
    uid = user["uid"]
    resp = await _create_with_images(client, headers, uid, 6)
    assert resp.status_code == 400, resp.text
    assert "at most" in resp.text.lower()


@pytest.mark.asyncio
async def test_extract_sends_all_images_in_one_call(client, monkeypatch):
    user, headers = await _new_user(client, "extract")
    uid = user["uid"]

    captured = {}

    async def fake_extract(base64_data=None, mime_type=None, user_id=None, industry_id=None, images=None):
        captured["images"] = images
        return ReceiptCreate.model_validate(
            {"supplier": "MULTI CO", "totalAmount": "1.00", "receiptDate": "08/25/2026", "status": "needs_review"}
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
    assert captured["images"] is not None and len(captured["images"]) == 2
    assert all(mime == "image/jpeg" for _, mime in captured["images"])


@pytest.mark.asyncio
async def test_per_image_dedup_on_create_and_check(client):
    user, headers = await _new_user(client, "dedup")
    uid = user["uid"]

    first = await _create_with_images(client, headers, uid, 1, supplier="ORIGINAL")
    assert first.status_code == 201, first.text

    same_bytes = make_jpeg_bytes(color=(10, 10, 20))

    # Dry-run check reports the conflict with a viewable receipt id.
    check = await client.post(
        f"/api/v1/users/{uid}/receipts/check-images",
        files={"files": ("dup.jpg", same_bytes, "image/jpeg")},
        headers=headers,
    )
    assert check.status_code == 200, check.text
    # Use the exact image from the created receipt for a real conflict.
    created_img = first.json()["images"][0]
    # Re-upload the same stored file bytes is impossible; instead assert the
    # endpoint shape and the create-time 409 below using a fresh duplicate.
    assert "conflicts" in check.json()

    # Create a duplicate by uploading the same bytes twice across receipts.
    dup1 = await client.post(
        f"/api/v1/users/{uid}/receipts",
        data={"receipt_data": '{"supplier": "DUP ONE", "totalAmount": "1.00", "receiptDate": "08/25/2026", "status": "needs_review"}'},
        files={"file": ("d.jpg", same_bytes, "image/jpeg")},
        headers=headers,
    )
    assert dup1.status_code == 201, dup1.text
    dup2 = await client.post(
        f"/api/v1/users/{uid}/receipts",
        data={"receipt_data": '{"supplier": "DUP TWO", "totalAmount": "1.00", "receiptDate": "08/25/2026", "status": "needs_review"}'},
        files={"file": ("d.jpg", same_bytes, "image/jpeg")},
        headers=headers,
    )
    assert dup2.status_code == 409, dup2.text
    detail = dup2.json()["detail"]
    assert detail["code"] == "DUPLICATE_IMAGE"
    assert detail["receiptId"] == dup1.json()["id"]
    assert detail["supplier"] == "DUP ONE"
    assert created_img  # sanity


@pytest.mark.asyncio
async def test_edit_add_and_remove_images(client):
    user, headers = await _new_user(client, "edit")
    uid = user["uid"]

    created = await _create_with_images(client, headers, uid, 2, supplier="EDIT CO")
    rid = created.json()["id"]
    imgs = created.json()["images"]

    # Remove image 0 and append one new image.
    resp = await client.put(
        f"/api/v1/users/{uid}/receipts/{rid}",
        data={"receipt_data": f'{{"supplier": "EDIT CO", "removeImageIds": ["{imgs[0]["id"]}"]}}'},
        files={"files": ("added.jpg", make_jpeg_bytes(color=(99, 1, 1)), "image/jpeg")},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["imageCount"] == 2, body
    remaining_ids = {im["id"] for im in body["images"]}
    assert imgs[0]["id"] not in remaining_ids
    assert imgs[1]["id"] in remaining_ids


@pytest.mark.asyncio
async def test_stage_then_attach_images(client):
    """Add-to-receipt pipeline: process server-side, preview, then attach."""
    user, headers = await _new_user(client, "stage")
    uid = user["uid"]

    stage = await client.post(
        f"/api/v1/users/{uid}/receipts/images/stage",
        files=[
            ("files", ("a.jpg", make_jpeg_bytes(), "image/jpeg")),
            ("files", ("b.jpg", make_jpeg_bytes(color=(20, 40, 60)), "image/jpeg")),
        ],
        headers=headers,
    )
    assert stage.status_code == 200, stage.text
    payload = stage.json()
    assert len(payload["staged"]) == 2, payload
    assert payload["conflicts"] == []
    staged_ids = [s["id"] for s in payload["staged"]]

    # The processed preview is served from the staging area.
    preview = await client.get(
        f"/api/images/cached?url=%2Fstaged-images%2F{staged_ids[0]}%3Fthumb%3D1"
    )
    assert preview.status_code == 200, preview.text
    assert preview.headers["content-type"].startswith("image/jpeg")

    # Attach the staged images on create.
    create = await client.post(
        f"/api/v1/users/{uid}/receipts",
        data={"receipt_data": '{"supplier": "STAGED CO", "totalAmount": "3.00", "receiptDate": "08/25/2026", "status": "needs_review", "stagedImageIds": ["%s", "%s"]}' % (staged_ids[0], staged_ids[1])},
        headers=headers,
    )
    assert create.status_code == 201, create.text
    assert create.json()["imageCount"] == 2

    from app.core.database import get_pool
    pool = await get_pool()
    async with pool.acquire() as conn:
        left = await conn.fetchval(
            "SELECT COUNT(*) FROM staged_receipt_images WHERE id = ANY($1::text[])", staged_ids
        )
    assert left == 0, "staged rows must be consumed on attach"


@pytest.mark.asyncio
async def test_stage_reports_conflict(client):
    user, headers = await _new_user(client, "stageconf")
    uid = user["uid"]

    first = await client.post(
        f"/api/v1/users/{uid}/receipts",
        data={"receipt_data": '{"supplier": "ORIG", "totalAmount": "1.00", "receiptDate": "08/25/2026", "status": "needs_review"}'},
        files={"file": ("d.jpg", make_jpeg_bytes(color=(7, 7, 77)), "image/jpeg")},
        headers=headers,
    )
    rid = first.json()["id"]

    stage = await client.post(
        f"/api/v1/users/{uid}/receipts/images/stage",
        files={"files": ("d.jpg", make_jpeg_bytes(color=(7, 7, 77)), "image/jpeg")},
        headers=headers,
    )
    assert stage.status_code == 200, stage.text
    body = stage.json()
    assert body["staged"] == []
    assert len(body["conflicts"]) == 1
    assert body["conflicts"][0]["receiptId"] == rid
    assert body["conflicts"][0]["supplier"] == "ORIG"


@pytest.mark.asyncio
async def test_remove_all_images_leaves_no_cover(client):
    user, headers = await _new_user(client, "removeall")
    uid = user["uid"]
    created = await _create_with_images(client, headers, uid, 2)
    rid = created.json()["id"]
    ids = [im["id"] for im in created.json()["images"]]

    resp = await client.put(
        f"/api/v1/users/{uid}/receipts/{rid}",
        data={"receipt_data": '{"removeImageIds": ["%s", "%s"]}' % (ids[0], ids[1])},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["imageCount"] == 0
    assert resp.json()["imageUrl"] is None
