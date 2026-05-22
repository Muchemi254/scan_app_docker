"""
Firebase Storage → local filesystem image migration.

Downloads all legacy receipt images from Firebase Storage URLs and saves
them to the local filesystem.  Runs incrementally — images already on disk
are skipped.

Usage:
    python scripts/download_images.py

Requires: httpx, asyncpg, and IMAGE_STORAGE_DIR configured.
"""
import asyncio
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import httpx
from app.core.config import settings

IMAGE_DIR = settings.IMAGE_STORAGE_DIR
DATABASE_URL = settings.DATABASE_URL
CONCURRENCY = 10


async def main():
    import asyncpg

    pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=5)
    os.makedirs(IMAGE_DIR, exist_ok=True)

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, legacy_image_url FROM receipts
            WHERE legacy_image_url IS NOT NULL
              AND image_filename IS NULL
            """
        )

    if not rows:
        print("No images to download.")
        await pool.close()
        return

    print(f"Downloading {len(rows)} images...")
    sem = asyncio.Semaphore(CONCURRENCY)
    downloaded = 0
    skipped = 0
    failed = 0

    async def _download_one(rid: str, url: str):
        nonlocal downloaded, skipped, failed
        filename = f"{rid}.jpg"
        filepath = os.path.join(IMAGE_DIR, filename)

        if os.path.exists(filepath):
            skipped += 1
            return

        async with sem:
            try:
                async with httpx.AsyncClient(timeout=60) as client:
                    resp = await client.get(url)
                    resp.raise_for_status()
                    raw = resp.content

                # Convert HEIC if needed
                ct = resp.headers.get("content-type", "image/jpeg")
                if "heic" in ct.lower() or "heif" in ct.lower():
                    from app.services.image_service import process_image
                    raw, _ = process_image(raw, ct)

                with open(filepath, "wb") as f:
                    f.write(raw)

                # Update DB
                async with pool.acquire() as conn:
                    await conn.execute(
                        "UPDATE receipts SET image_filename = $2 WHERE id = $1::uuid",
                        rid, filename,
                    )

                downloaded += 1
                if downloaded % 10 == 0:
                    print(f"  Downloaded {downloaded}/{len(rows)}")

            except Exception as e:
                failed += 1
                print(f"  FAILED {rid[:12]}: {e}")

    tasks = [_download_one(str(r["id"]), r["legacy_image_url"]) for r in rows]
    await asyncio.gather(*tasks)

    print(f"\nDone: {downloaded} downloaded, {skipped} skipped, {failed} failed")
    await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
