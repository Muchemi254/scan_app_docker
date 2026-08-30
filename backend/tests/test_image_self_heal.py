"""Rebuild-proof image storage — DB mirror sync + boot self-heal."""
import os

import pytest

from app.core.config import settings
from tests.helpers import ADMIN_EMAIL, ADMIN_PASSWORD, create_user_via_admin, login, make_jpeg_bytes


async def _new_user(client):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    user = await create_user_via_admin(client, admin_headers, "heal@pytest.local", "testpass123")
    headers, _, _ = await login(client, "heal@pytest.local", "testpass123")
    return user, headers


async def _create_with_image(client, headers, uid, supplier="Heal Co"):
    resp = await client.post(
        f"/api/v1/users/{uid}/receipts",
        data={"receipt_data": (
            f'{{"supplier": "{supplier}", "totalAmount": "10.00", '
            '"receiptDate": "08/25/2026", "status": "needs_review"}'
        )},
        files={"file": ("r.jpg", make_jpeg_bytes(width=1200, height=900), "image/jpeg")},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


@pytest.mark.asyncio
async def test_create_mirrors_bytes_into_db(client):
    from app.services.database_service import fetch_receipt_image_bytes

    user, headers = await _new_user(client)
    receipt = await _create_with_image(client, headers, user["uid"])

    main = await fetch_receipt_image_bytes(receipt["id"], thumb=False)
    thumb = await fetch_receipt_image_bytes(receipt["id"], thumb=True)
    assert main is not None and len(main) > 0
    assert thumb is not None and len(thumb) > 0


@pytest.mark.asyncio
async def test_serving_rematerializes_file_from_db_mirror(client):
    user, headers = await _new_user(client)
    receipt = await _create_with_image(client, headers, user["uid"])
    rid = receipt["id"]
    path = os.path.join(settings.IMAGE_STORAGE_DIR, f"{rid}.jpg")

    assert os.path.exists(path)
    os.remove(path)  # simulate a wiped image volume

    # Serving path must recover from the DB mirror and rewrite the file
    full = await client.get(f"/api/images/cached?url=%2Freceipt-images%2F{rid}")
    assert full.status_code == 200, full.text
    assert full.headers["content-type"] == "image/jpeg"
    assert os.path.exists(path), "serving should re-materialize the file"

    # Thumbnail path too
    tpath = os.path.join(settings.IMAGE_STORAGE_DIR, f"{rid}_thumb.jpg")
    os.remove(tpath)
    thumb = await client.get(f"/api/images/cached?url=%2Freceipt-images%2F{rid}&thumb=1")
    assert thumb.status_code == 200, thumb.text
    assert os.path.exists(tpath)


@pytest.mark.asyncio
async def test_self_heal_backfills_and_repairs(client):
    from app.services.database_service import self_heal_image_files

    user, headers = await _new_user(client)
    receipt = await _create_with_image(client, headers, user["uid"])
    rid = receipt["id"]
    path = os.path.join(settings.IMAGE_STORAGE_DIR, f"{rid}.jpg")

    # Already mirrored at create; delete both mirror + file for one receipt
    # by simulating a receipt row without a mirror (backfill path)
    from app.core.database import get_pool
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE receipts SET image_bytes = NULL, thumb_bytes = NULL WHERE id = $1", rid
        )
    stats = await self_heal_image_files()
    assert stats["backfilled"] >= 1

    # Repair path: remove the file, keep the mirror
    os.remove(path)
    tpath = os.path.join(settings.IMAGE_STORAGE_DIR, f"{rid}_thumb.jpg")
    os.remove(tpath)
    stats = await self_heal_image_files()
    assert stats["repaired"] >= 1
    assert os.path.exists(path)
    assert os.path.exists(tpath)
