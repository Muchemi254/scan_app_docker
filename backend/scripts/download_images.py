"""
Firebase Storage → local filesystem image download.

Uses Firebase Admin SDK for downloads (avoids token expiration issues).
Safe to interrupt and re-run — skips already-downloaded images.

Usage:
    cd backend
    GEMINI_API_KEY=test-key \
    FIREBASE_CREDENTIALS_PATH=../firebaseservice.json \
    python scripts/download_images.py [user_id]
"""
import asyncio
import os
import re
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import asyncpg
import firebase_admin
from firebase_admin import credentials, storage
from app.core.config import settings

IMAGE_DIR = os.environ.get("IMAGE_STORAGE_DIR", settings.IMAGE_STORAGE_DIR)
DATABASE_URL = os.environ.get("DATABASE_URL", settings.DATABASE_URL)
os.makedirs(IMAGE_DIR, exist_ok=True)

CONCURRENCY = 8


def extract_storage_path(url: str) -> str | None:
    """Extract the blob path from a Firebase Storage URL like:
    https://firebasestorage.googleapis.com/v0/b/BUCKET/o/PATH?alt=media&token=...
    """
    m = re.search(r'/o/(.+?)(?:\?|$)', url)
    if m:
        import urllib.parse
        return urllib.parse.unquote(m.group(1))
    return None


async def main(user_id: str = None):
    # Init Firebase
    creds_path = os.environ.get("FIREBASE_CREDENTIALS_PATH", "../firebaseservice.json")
    if not firebase_admin._apps:
        cred = credentials.Certificate(creds_path)
        firebase_admin.initialize_app(cred, {"storageBucket": "pyandroid-2afb9.appspot.com"})

    bucket = storage.bucket()
    pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=10)

    async with pool.acquire() as conn:
        if user_id:
            rows = await conn.fetch(
                "SELECT id, legacy_image_url FROM receipts "
                "WHERE user_id = $1 AND legacy_image_url IS NOT NULL AND image_filename IS NULL",
                user_id,
            )
        else:
            rows = await conn.fetch(
                "SELECT id, legacy_image_url FROM receipts "
                "WHERE legacy_image_url IS NOT NULL AND image_filename IS NULL"
            )

    if not rows:
        print("No images to download — all done!")
        await pool.close()
        return

    print(f"Downloading {len(rows)} images to {IMAGE_DIR} (concurrency={CONCURRENCY})...")
    sem = asyncio.Semaphore(CONCURRENCY)
    stats = {"downloaded": 0, "skipped": 0, "failed": 0}
    heic_fail = 0

    async def _download_one(rid: str, url: str):
        nonlocal heic_fail
        filename = f"{rid}.jpg"
        filepath = os.path.join(IMAGE_DIR, filename)

        if os.path.exists(filepath):
            stats["skipped"] += 1
            return

        blob_path = extract_storage_path(url)
        if not blob_path:
            stats["failed"] += 1
            return

        async with sem:
            try:
                blob = bucket.blob(blob_path)
                raw = await asyncio.to_thread(blob.download_as_bytes)

                if not raw:
                    stats["failed"] += 1
                    return

                # Try HEIC conversion
                ct = blob.content_type or "image/jpeg"
                if "heic" in ct.lower() or "heif" in ct.lower():
                    try:
                        from app.services.image_service import process_image
                        raw, _ = process_image(raw, ct)
                    except Exception:
                        heic_fail += 1
                        if heic_fail <= 3:
                            print(f"  HEIC fmt for {rid[:20]}... — storing raw")
                        # Store raw bytes — the proxy will handle conversion on read

                with open(filepath, "wb") as f:
                    f.write(raw)

                async with pool.acquire() as conn:
                    await conn.execute(
                        "UPDATE receipts SET image_filename = $2 WHERE id = $1",
                        rid, filename,
                    )

                stats["downloaded"] += 1
                if stats["downloaded"] % 25 == 0:
                    print(f"  {stats['downloaded']}/{len(rows)} downloaded...")

            except Exception as e:
                stats["failed"] += 1
                if stats["failed"] <= 5:
                    print(f"  FAILED {rid[:20]}...: {e}")

    tasks = [_download_one(str(r["id"]), r["legacy_image_url"]) for r in rows]
    await asyncio.gather(*tasks)

    print(f"\nDone: {stats['downloaded']} downloaded, {stats['skipped']} skipped, {stats['failed']} failed")
    if heic_fail:
        print(f"  ({heic_fail} HEIC images stored raw — proxy will convert on access)")
    await pool.close()


if __name__ == "__main__":
    uid = sys.argv[1] if len(sys.argv) > 1 else None
    asyncio.run(main(uid))
