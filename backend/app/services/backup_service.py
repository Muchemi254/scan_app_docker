"""
Backup service — export/import user data + images.

Backup format (tar.gz):
    backup/
      data.json         # All receipts, items, settings, tasks, review_batches
      images/
        {receipt_id}.jpg
        {receipt_id}_thumb.jpg
      manifest.json     # version, timestamp, user_id, counts, checksums

Streaming design — never holds more than one image in memory.
"""

import json
import hashlib
import logging
import os
import tarfile
import io
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional, List, Dict, Any

from app.core.database import get_pool
from app.core.config import settings

logger = logging.getLogger(__name__)

MANIFEST_VERSION = 1


# ═══════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════

def _serialize_row(row):
    if not row:
        return None
    d = dict(row)
    for k, v in d.items():
        if isinstance(v, (datetime,)):
            d[k] = v.isoformat()
        elif isinstance(v, (Decimal,)):
            d[k] = float(v)
        elif hasattr(v, 'isoformat'):
            d[k] = v.isoformat()
    return d


# ═══════════════════════════════════════════════════════════════════════════
# Export
# ═══════════════════════════════════════════════════════════════════════════

async def export_user_data(user_id: str) -> dict:
    """
    Create a complete backup tar.gz on disk (streaming, no memory accumulation
    for images).  Returns metadata dict so the API can find the file.

    Returns dict: { "path": str, "id": str, "size_bytes": int, "counts": {...} }
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        receipt_rows = await conn.fetch(
            "SELECT * FROM receipts WHERE user_id = $1", user_id
        )
        receipt_ids = [r["id"] for r in receipt_rows]

        items_rows = await conn.fetch(
            "SELECT * FROM line_items WHERE receipt_id = ANY($1)", receipt_ids
        ) if receipt_ids else []

        audit_rows = await conn.fetch(
            "SELECT * FROM audit_logs WHERE user_id = $1", user_id
        )
        tasks_rows = await conn.fetch(
            "SELECT * FROM tasks WHERE user_id = $1", user_id
        )
        settings_row = await conn.fetchrow(
            "SELECT * FROM user_ai_settings WHERE user_id = $1", user_id
        )
        review_batches_rows = await conn.fetch(
            "SELECT * FROM review_batches WHERE user_id = $1", user_id
        )
        batch_ids = [r["id"] for r in review_batches_rows]
        review_items_rows = await conn.fetch(
            "SELECT * FROM review_batch_items WHERE batch_id = ANY($1)", batch_ids
        ) if batch_ids else []

    # ── Build data.json dict ──
    data = {
        "receipts": [_serialize_row(r) for r in receipt_rows],
        "line_items": [_serialize_row(r) for r in items_rows],
        "audit_logs": [_serialize_row(r) for r in audit_rows],
        "tasks": [_serialize_row(r) for r in tasks_rows],
        "review_batches": [_serialize_row(r) for r in review_batches_rows],
        "review_batch_items": [_serialize_row(r) for r in review_items_rows],
        "user_ai_settings": _serialize_row(settings_row),
    }

    if data.get("user_ai_settings"):
        configs = data["user_ai_settings"].get("configs", {})
        if isinstance(configs, str):
            configs = json.loads(configs)
        if isinstance(configs, dict):
            for provider in list(configs.keys()):
                if isinstance(configs[provider], dict):
                    configs[provider]["api_key"] = "[REDACTED]"
            data["user_ai_settings"]["configs"] = configs

    data_json = json.dumps(data, indent=2, default=str).encode("utf-8")
    data_hash = hashlib.sha256(data_json).hexdigest()

    # ── Collect image filenames belonging to this user ──
    image_files = []
    if os.path.isdir(settings.IMAGE_STORAGE_DIR):
        for fn in sorted(os.listdir(settings.IMAGE_STORAGE_DIR)):
            if not fn.endswith(".jpg"):
                continue
            rid = fn.replace("_thumb.jpg", "").replace(".jpg", "")
            if rid in receipt_ids or fn.split(".")[0].split("_")[0] in receipt_ids:
                image_files.append(fn)

    # ── Build manifest ──
    manifest = {
        "version": MANIFEST_VERSION,
        "user_id": user_id,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "counts": {
            "receipts": len(receipt_rows),
            "line_items": len(items_rows),
            "tasks": len(tasks_rows),
            "audit_logs": len(audit_rows),
            "settings": 1 if settings_row else 0,
            "review_batches": len(review_batches_rows),
        },
        "data_sha256": data_hash,
        "image_count": len(image_files),
        "images_sha256": "none",
    }

    # ── Write tar.gz to disk (streaming — never hold >1 image in RAM) ──
    os.makedirs(settings.BACKUP_STORAGE_DIR, exist_ok=True)
    backup_id = str(uuid.uuid4())[:8]
    filepath = os.path.join(settings.BACKUP_STORAGE_DIR, f"{backup_id}.tar.gz")

    img_hasher = hashlib.sha256()
    img_count = 0

    with tarfile.open(filepath, "w:gz") as tar:
        # data.json
        info = tarfile.TarInfo(name="backup/data.json")
        info.size = len(data_json)
        tar.addfile(info, io.BytesIO(data_json))

        # Images — streamed one by one
        for fn in image_files:
            fpath = os.path.join(settings.IMAGE_STORAGE_DIR, fn)
            info = tar.gettarinfo(fpath, arcname=f"backup/images/{fn}")
            with open(fpath, "rb") as imgf:
                # Update hash while streaming
                chunk = imgf.read(65536)
                while chunk:
                    img_hasher.update(chunk)
                    chunk = imgf.read(65536)
                imgf.seek(0)
                tar.addfile(info, imgf)
            img_count += 1

        manifest["image_count"] = img_count
        manifest["images_sha256"] = img_hasher.hexdigest() if img_count else "none"

        manifest_json = json.dumps(manifest, indent=2).encode("utf-8")
        info = tarfile.TarInfo(name="backup/manifest.json")
        info.size = len(manifest_json)
        tar.addfile(info, io.BytesIO(manifest_json))

    size_bytes = os.path.getsize(filepath)
    logger.info("Backup exported: %d receipts, %d images, %d KB",
                len(receipt_rows), img_count, size_bytes // 1024)

    return {
        "path": filepath,
        "id": backup_id,
        "size_bytes": size_bytes,
        "counts": manifest["counts"],
        "image_count": img_count,
    }


# ═══════════════════════════════════════════════════════════════════════════
# Import
# ═══════════════════════════════════════════════════════════════════════════

async def import_user_data(
    user_id: str,
    filepath: str,
    conflict: str = "skip",
    selected_ids: Optional[List[str]] = None,
) -> dict:
    """
    Restore data from a backup tar.gz file.

    Streaming — processes entries one by one, never holds all images in RAM.
    """
    pool = await get_pool()

    data = None
    manifest = {}
    image_entries: Dict[str, bytes] = {}

    # ── Parse tar — stream through entries ──
    with tarfile.open(filepath, "r:gz") as tar:
        for member in tar:
            if member.name == "backup/data.json":
                data = json.loads(tar.extractfile(member).read())
            elif member.name == "backup/manifest.json":
                manifest = json.loads(tar.extractfile(member).read())
            elif member.name.startswith("backup/images/") and member.name.endswith(".jpg"):
                fn = os.path.basename(member.name)
                image_entries[fn] = member  # store member ref, not bytes

    if not data:
        raise ValueError("Invalid backup: no data.json found")

    stats = {"receipts": 0, "items": 0, "tasks": 0, "settings": 0,
             "images": 0, "skipped": 0, "errors": 0}

    async with pool.acquire() as conn:
        async with conn.transaction():
            # ── Receipts ──
            for r in data.get("receipts", []):
                rid = r["id"]
                if selected_ids and rid not in selected_ids:
                    continue

                existing = await conn.fetchrow(
                    "SELECT id FROM receipts WHERE id = $1 AND user_id = $2",
                    rid, user_id,
                )
                if existing and conflict == "skip":
                    stats["skipped"] += 1
                    continue
                if existing and conflict == "overwrite":
                    await conn.execute("DELETE FROM receipts WHERE id = $1", rid)

                await conn.execute("""
                    INSERT INTO receipts (id, user_id, status, supplier, total_amount,
                        tax_amount, receipt_date, category, invoice_number, kra_pin,
                        cu_invoice, batch_title, image_filename, thumbnail_filename,
                        legacy_image_url, scanned_at, created_at, updated_at)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
                    ON CONFLICT (id) DO UPDATE SET
                        supplier = EXCLUDED.supplier,
                        total_amount = EXCLUDED.total_amount,
                        tax_amount = EXCLUDED.tax_amount,
                        receipt_date = EXCLUDED.receipt_date,
                        category = EXCLUDED.category,
                        invoice_number = EXCLUDED.invoice_number,
                        kra_pin = EXCLUDED.kra_pin,
                        cu_invoice = EXCLUDED.cu_invoice,
                        batch_title = EXCLUDED.batch_title,
                        image_filename = EXCLUDED.image_filename,
                        thumbnail_filename = EXCLUDED.thumbnail_filename,
                        legacy_image_url = EXCLUDED.legacy_image_url,
                        updated_at = NOW()
                """, rid, user_id,
                    r.get("status", "processed"),
                    r.get("supplier", ""),
                    Decimal(str(r.get("total_amount", "0"))),
                    Decimal(str(r["tax_amount"])) if r.get("tax_amount") else None,
                    r.get("receipt_date"),
                    r.get("category"),
                    r.get("invoice_number"),
                    r.get("kra_pin"),
                    r.get("cu_invoice"),
                    r.get("batch_title"),
                    r.get("image_filename"),
                    r.get("thumbnail_filename"),
                    r.get("legacy_image_url"),
                    r.get("scanned_at"),
                    r.get("created_at"),
                    r.get("updated_at"),
                )
                stats["receipts"] += 1

            # ── Line items ──
            for li in data.get("line_items", []):
                rid = li.get("receipt_id")
                if selected_ids and rid not in selected_ids:
                    continue
                try:
                    await conn.execute("""
                        INSERT INTO line_items (receipt_id, sort_order, name, quantity,
                            price, tax, is_zero_rated, discount)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                        ON CONFLICT DO NOTHING
                    """, rid, li.get("sort_order", 0),
                        li.get("name", ""),
                        float(li.get("quantity", 1)),
                        Decimal(str(li.get("price", "0"))),
                        Decimal(str(li.get("tax", "0"))),
                        li.get("is_zero_rated", False),
                        Decimal(str(li.get("discount"))) if li.get("discount") else None,
                    )
                    stats["items"] += 1
                except Exception:
                    stats["errors"] += 1

            # ── Tasks ──
            for t in data.get("tasks", []):
                try:
                    await conn.execute("""
                        INSERT INTO tasks (id, user_id, task_type, batch_title, status,
                            total_items, completed_items, current_step, total_steps,
                            percentage, message, error, metadata, results,
                            created_at, updated_at, started_at, completed_at)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
                        ON CONFLICT (id) DO NOTHING
                    """, t["id"], user_id,
                        t.get("task_type", "scan_batch"),
                        t.get("batch_title", ""),
                        t.get("status", "queued"),
                        t.get("total_items", 0),
                        t.get("completed_items", 0),
                        t.get("current_step", 0),
                        t.get("total_steps", 0),
                        t.get("percentage", 0),
                        t.get("message", ""),
                        t.get("error"),
                        json.dumps(t.get("metadata", {})),
                        json.dumps(t.get("results", {})),
                        t.get("created_at"),
                        t.get("updated_at"),
                        t.get("started_at"),
                        t.get("completed_at"),
                    )
                    stats["tasks"] += 1
                except Exception:
                    stats["errors"] += 1

            # ── Settings ──
            s = data.get("user_ai_settings")
            if s:
                try:
                    await conn.execute("""
                        INSERT INTO user_ai_settings (user_id, provider, model_id, configs)
                        VALUES ($1,$2,$3,$4)
                        ON CONFLICT (user_id) DO NOTHING
                    """, user_id,
                        s.get("provider", "gemini"),
                        s.get("model_id", "gemini-3-flash-preview"),
                        json.dumps(s.get("configs", {})),
                    )
                    stats["settings"] += 1
                except Exception:
                    stats["errors"] += 1

            # ── Review batches ──
            for rb in data.get("review_batches", []):
                try:
                    await conn.execute("""
                        INSERT INTO review_batches (id, user_id, name, csv_filename, created_at, updated_at)
                        VALUES ($1,$2,$3,$4,$5,$6)
                        ON CONFLICT (id) DO NOTHING
                    """, rb["id"], user_id, rb.get("name", ""),
                        rb.get("csv_filename"), rb.get("created_at"), rb.get("updated_at"))
                except Exception:
                    stats["errors"] += 1

            for rbi in data.get("review_batch_items", []):
                try:
                    await conn.execute("""
                        INSERT INTO review_batch_items (batch_id, receipt_id, review_status, reviewer_notes, reviewed_at)
                        VALUES ($1,$2,$3,$4,$5)
                        ON CONFLICT (batch_id, receipt_id) DO NOTHING
                    """, rbi.get("batch_id"), rbi.get("receipt_id"),
                        rbi.get("review_status", "pending_review"),
                        rbi.get("reviewer_notes"), rbi.get("reviewed_at"))
                except Exception:
                    stats["errors"] += 1

    # ── Restore images — stream from tar member to disk one by one ──
    os.makedirs(settings.IMAGE_STORAGE_DIR, exist_ok=True)
    with tarfile.open(filepath, "r:gz") as tar:
        for member in tar:
            if not (member.name.startswith("backup/images/") and member.name.endswith(".jpg")):
                continue
            fn = os.path.basename(member.name)
            rid = fn.replace("_thumb.jpg", "").replace(".jpg", "")
            if selected_ids and rid not in selected_ids:
                continue
            fpath = os.path.join(settings.IMAGE_STORAGE_DIR, fn)
            if conflict == "skip" and os.path.exists(fpath):
                continue
            with tar.extractfile(member) as src, open(fpath, "wb") as dst:
                while True:
                    chunk = src.read(65536)
                    if not chunk:
                        break
                    dst.write(chunk)
            stats["images"] += 1

    logger.info("Backup imported: %s", stats)
    return stats


# ═══════════════════════════════════════════════════════════════════════════
# Preview
# ═══════════════════════════════════════════════════════════════════════════

def parse_backup(filepath: str) -> dict:
    """Parse a backup tar.gz without loading images into memory."""
    result = {"manifest": {}, "receipt_count": 0, "image_count": 0,
              "receipts": [], "size_kb": os.path.getsize(filepath) // 1024}

    with tarfile.open(filepath, "r:gz") as tar:
        for member in tar:
            if member.name == "backup/data.json":
                data = json.loads(tar.extractfile(member).read())
                for r in data.get("receipts", []):
                    result["receipts"].append({
                        "id": r.get("id", ""),
                        "supplier": r.get("supplier", "")[:40],
                        "totalAmount": str(r.get("total_amount", 0)),
                        "receiptDate": str(r.get("receipt_date", "")),
                        "category": r.get("category", ""),
                        "status": r.get("status", ""),
                        "hasImage": bool(r.get("image_filename")),
                    })
                result["receipt_count"] = len(result["receipts"])
            elif member.name == "backup/manifest.json":
                result["manifest"] = json.loads(tar.extractfile(member).read())
            elif member.name.startswith("backup/images/"):
                result["image_count"] += 1

    return result
