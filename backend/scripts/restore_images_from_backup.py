"""
Restore receipt image files into IMAGE_STORAGE_DIR from backup tar.gz exports.

Use this when the image volume has lost files but the Postgres rows (with
their ``image_filename`` references) are intact — e.g. after an accidental
volume wipe/prune. Extracts only files still referenced by live receipts
(full images + thumbnails), so orphan files are never re-introduced.

Usage (inside the backend container):
    python scripts/restore_images_from_backup.py /path/backup1.tar.gz [/path/backup2.tar.gz ...]

Idempotent: existing files are left untouched. Prints a summary:
    wanted=N extracted=N existing=N missing=N
"""
import asyncio
import os
import sys
import tarfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import asyncpg

from app.core.config import settings


async def fetch_referenced() -> set[str]:
    conn = await asyncpg.connect(settings.DATABASE_URL)
    try:
        rows = await conn.fetch(
            "SELECT image_filename, thumbnail_filename FROM receipts "
            "WHERE image_filename IS NOT NULL"
        )
    finally:
        await conn.close()

    wanted: set[str] = set()
    for row in rows:
        name = row["image_filename"]
        wanted.add(name)
        thumb = row["thumbnail_filename"]
        if thumb:
            wanted.add(thumb)
        elif name.endswith(".jpg"):
            wanted.add(name[: -len(".jpg")] + "_thumb.jpg")
    return wanted


def extract_wanted(tar_path: str, wanted: set[str], dest_dir: str, stats: dict) -> None:
    if not os.path.exists(tar_path):
        print(f"SKIP (not found): {tar_path}")
        return
    with tarfile.open(tar_path, "r:gz") as tar:
        for member in tar:
            if not member.name.startswith("backup/images/") or not member.isfile():
                continue
            if not (member.name.endswith(".jpg") or member.name.endswith(".pdf")):
                continue
            fn = os.path.basename(member.name)
            if fn not in wanted:
                continue
            target = os.path.join(dest_dir, fn)
            if os.path.exists(target):
                stats["existing"] += 1
                continue
            with tar.extractfile(member) as src, open(target, "wb") as dst:
                while True:
                    chunk = src.read(65536)
                    if not chunk:
                        break
                    dst.write(chunk)
            stats["extracted"] += 1
            stats["found"].add(fn)


async def main() -> int:
    tar_paths = sys.argv[1:]
    if not tar_paths:
        print("usage: python scripts/restore_images_from_backup.py <backup.tar.gz> [...]")
        return 2

    dest_dir = settings.IMAGE_STORAGE_DIR
    os.makedirs(dest_dir, exist_ok=True)
    print(f"Destination: {dest_dir}")

    wanted = await fetch_referenced()
    print(f"Referenced files in DB: {len(wanted)}")

    stats = {"extracted": 0, "existing": 0, "found": set()}
    for path in tar_paths:
        extract_wanted(path, wanted, dest_dir, stats)

    missing = wanted - stats["found"]
    print(
        f"Summary: extracted={stats['extracted']} already-on-disk={stats['existing']} "
        f"still-missing={len(missing)}"
    )
    for name in sorted(missing)[:20]:
        print(f"  MISSING: {name}")
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
