"""
PostgreSQL database service — direct asyncpg queries.

Replaces DatabaseService with identical method signatures and return
types (Dict[str, Any]) so every API route, Pydantic schema, and the
entire frontend require zero changes.

Items are stored in a separate line_items table (with FK to receipts)
and reconstructed as a list of dicts on read, matching the existing
ReceiptItem shape.

Images are stored on the local filesystem; the API composes image URLs
as /receipt-images/{id} routes served by the existing image proxy.
"""

import logging
import os
import uuid
import re
from datetime import datetime, timezone, date
from decimal import Decimal
from typing import Optional, List, Dict, Any

from app.core.database import get_pool
from app.core.config import settings
from app.schemas.receipt import ReceiptStatus

logger = logging.getLogger(__name__)


# ═══════════════════════════════════════════════════════════════════════════
# Helpers
# ═══════════════════════════════════════════════════════════════════════════

def sanitize_numeric(value: Any) -> float:
    """Strip currency symbols, commas, whitespace — return float.  Returns 0.0 on failure."""
    if value is None:
        return 0.0
    if isinstance(value, (int, float, Decimal)):
        return float(value)
    cleaned = re.sub(r"[^0-9.\-]", "", str(value))
    try:
        return float(cleaned)
    except ValueError:
        return 0.0


def _parse_date_mmddyyyy(s: str) -> Optional[date]:
    """Parse MM/DD/YYYY → Python date.  Returns None on failure."""
    if not s:
        return None
    try:
        parts = s.strip().split("/")
        if len(parts) == 3:
            return date(int(parts[2]), int(parts[0]), int(parts[1]))
    except (ValueError, TypeError):
        pass
    # try YYYY-MM-DD fallback
    try:
        return date.fromisoformat(s.strip())
    except (ValueError, TypeError):
        return None


def _format_date_mmddyyyy(d: date) -> str:
    """Python date → MM/DD/YYYY string."""
    return d.strftime("%m/%d/%Y")


def _to_numeric(val: Any) -> Optional[Decimal]:
    """Convert a value to Decimal for PostgreSQL NUMERIC columns, or None."""
    if val is None:
        return None
    try:
        return Decimal(str(val))
    except Exception:
        return None


# ═══════════════════════════════════════════════════════════════════════════
# Row → dict serializer
# ═══════════════════════════════════════════════════════════════════════════

def _receipt_row_to_dict(
    row, items: Optional[List[dict]] = None
) -> Dict[str, Any]:
    """
    Convert a PostgreSQL receipts row + reconstructed items into the
    same dict shape the API currently returns from Firestore.
    """
    rid = str(row["id"]) if not isinstance(row["id"], str) else row["id"]

    # Compute image + thumbnail URLs
    image_url = None
    thumbnail_url = None
    if row.get("image_filename"):
        image_url = f"/receipt-images/{rid}"
        thumbnail_url = f"/receipt-images/{rid}?thumb=1"
    elif row.get("legacy_image_url"):
        image_url = row["legacy_image_url"]
        thumbnail_url = row.get("legacy_thumbnail_url")  # may be None

    # Always return totalAmount/taxAmount as 2dp strings (contract)
    total_amount = row.get("total_amount")
    if total_amount is not None and not isinstance(total_amount, str):
        total_amount = format(Decimal(str(total_amount)), ".2f")

    tax_amount = row.get("tax_amount")
    if tax_amount is not None and not isinstance(tax_amount, str):
        tax_amount = format(Decimal(str(tax_amount)), ".2f")

    receipt_date = row.get("receipt_date")
    if isinstance(receipt_date, date):
        receipt_date = _format_date_mmddyyyy(receipt_date)

    return {
        "id": rid,
        "userId": row["user_id"],
        "status": row["status"],
        "supplier": row["supplier"],
        "totalAmount": total_amount,
        "taxAmount": tax_amount,
        "receiptDate": receipt_date,
        "category": row.get("category"),
        "invoiceNumber": row.get("invoice_number"),
        "kraPin": row.get("kra_pin"),
        "cuInvoice": row.get("cu_invoice"),
        "batchTitle": row.get("batch_title"),
        "imageUrl": image_url,
        "thumbnailUrl": thumbnail_url,
        "items": items or [],
        "createdAt": row.get("created_at"),
        "updatedAt": row.get("updated_at"),
        "scannedAt": row.get("scanned_at"),
    }


async def _fetch_items(conn, receipt_id: str) -> List[dict]:
    """Fetch line_items for a receipt, return as list of dicts (API shape)."""
    rows = await conn.fetch(
        """
        SELECT sort_order, name, quantity, price, tax, is_zero_rated, discount
        FROM line_items
        WHERE receipt_id = $1
        ORDER BY sort_order
        """,
        receipt_id,
    )
    items = []
    for r in rows:
        def _num_str(val, nullable=False):
            if val is None:
                return None if nullable else "0"
            d = Decimal(str(val))
            return format(d, ".2f")
        price_str = _num_str(r["price"])
        tax_str = _num_str(r["tax"])
        discount_val = r["discount"]
        discount_str = _num_str(discount_val, nullable=True)
        items.append({
            "name": r["name"],
            "quantity": float(r["quantity"]),
            "price": price_str,
            "tax": tax_str,
            "isZeroRated": r["is_zero_rated"],
            "discount": discount_str,
        })
    return items


# ═══════════════════════════════════════════════════════════════════════════
# DatabaseService — same interface as DatabaseService
# ═══════════════════════════════════════════════════════════════════════════

class DatabaseService:
    """PostgreSQL-backed service — drop-in replacement for DatabaseService."""

    # ── User AI Settings ──────────────────────────────────────────────────

    @staticmethod
    async def get_user_settings(user_id: str, settings_key: str) -> Optional[Dict[str, Any]]:
        pool = await get_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM user_ai_settings WHERE user_id = $1", user_id
            )
            if not row:
                return None
            return {
                "provider": row["provider"],
                "model_id": row["model_id"],
                "configs": row["configs"] or {},
            }

    @staticmethod
    async def update_user_settings(user_id: str, settings_key: str, data: Dict[str, Any]) -> bool:
        pool = await get_pool()
        import json
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO user_ai_settings (user_id, provider, model_id, configs)
                VALUES ($1, $2, $3, $4::jsonb)
                ON CONFLICT (user_id)
                DO UPDATE SET provider = $2, model_id = $3, configs = $4::jsonb
                """,
                user_id,
                data.get("provider", "gemini"),
                data.get("model_id", "gemini-3-flash-preview"),
                json.dumps(data.get("configs", {})),
            )
            return True

    # ── Receipt CRUD ──────────────────────────────────────────────────────

    @staticmethod
    async def create_receipt(user_id: str, receipt_data: Dict[str, Any]) -> str:
        """Insert receipt + line_items in a single transaction.  Returns receipt UUID string."""
        now = datetime.now(timezone.utc)
        receipt_date = _parse_date_mmddyyyy(receipt_data.get("receiptDate", ""))
        if not receipt_date:
            receipt_date = now.date()

        total = sanitize_numeric(receipt_data.get("totalAmount"))
        tax = sanitize_numeric(receipt_data.get("taxAmount")) if receipt_data.get("taxAmount") else None

        items = receipt_data.get("items") or []
        image_filename = receipt_data.get("image_filename")
        # Allow caller to pre-generate an ID (needed for image filenames)
        use_id = receipt_data.get("id")

        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    """
                    INSERT INTO receipts (id, user_id, status, supplier, total_amount, tax_amount,
                        receipt_date, category, invoice_number, kra_pin, cu_invoice,
                        batch_title, image_filename, scanned_at, created_at, updated_at)
                    VALUES (COALESCE($16, gen_random_uuid()), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
                    RETURNING id
                    """,
                    user_id,
                    receipt_data.get("status", "processed"),
                    receipt_data.get("supplier", ""),
                    total,
                    tax,
                    receipt_date,
                    receipt_data.get("category"),
                    receipt_data.get("invoiceNumber"),
                    receipt_data.get("kraPin"),
                    receipt_data.get("cuInvoice"),
                    receipt_data.get("batchTitle"),
                    image_filename,
                    now,
                    now,
                    now,
                    use_id,
                )
                receipt_id = row["id"]

                if items:
                    await conn.executemany(
                        """
                        INSERT INTO line_items (receipt_id, sort_order, name, quantity,
                            price, tax, is_zero_rated, discount)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                        """,
                        [
                            (
                                receipt_id,
                                i,
                                item.get("name", "N/A"),
                                float(item.get("quantity", 1)),
                                sanitize_numeric(item.get("price", "0")),
                                sanitize_numeric(item.get("tax", "0")),
                                item.get("isZeroRated", False),
                                _to_numeric(item.get("discount")),
                            )
                            for i, item in enumerate(items)
                        ],
                    )

        return str(receipt_id)

    @staticmethod
    async def get_receipt(user_id: str, receipt_id: str) -> Optional[Dict[str, Any]]:
        """Fetch single receipt with items."""
        pool = await get_pool()
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM receipts WHERE id = $1 AND user_id = $2",
                receipt_id, user_id,
            )
            if not row:
                return None
            items = await _fetch_items(conn, receipt_id)
            return _receipt_row_to_dict(row, items)

    @staticmethod
    async def get_receipts_by_ids(user_id: str, receipt_ids: List[str]) -> List[Dict[str, Any]]:
        """Fetch multiple receipts by their UUIDs."""
        if not receipt_ids:
            return []
        pool = await get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT * FROM receipts WHERE user_id = $1 AND id = ANY($2::text[])",
                user_id, receipt_ids,
            )
            results = []
            for row in rows:
                items = await _fetch_items(conn, str(row["id"]))
                results.append(_receipt_row_to_dict(row, items))
            return results

    @staticmethod
    async def list_receipts(
        user_id: str,
        skip: int = 0,
        limit: int = 50,
        status: Optional[str] = None,
        category: Optional[str] = None,
        batch_title: Optional[str] = None,
    ) -> tuple:
        """List receipts with filters and pagination. Returns (receipts, total)."""
        pool = await get_pool()
        async with pool.acquire() as conn:
            params = [user_id]
            conditions = ["user_id = $1"]
            param_idx = 2

            if status:
                params.append(status)
                conditions.append(f"status = ${param_idx}")
                param_idx += 1
            if category:
                params.append(category)
                conditions.append(f"category = ${param_idx}")
                param_idx += 1
            if batch_title and batch_title != "__ungrouped__":
                params.append(batch_title)
                conditions.append(f"batch_title = ${param_idx}")
                param_idx += 1
            elif batch_title == "__ungrouped__":
                conditions.append(
                    "(batch_title IS NULL OR batch_title = '' OR UPPER(batch_title) = 'N/A')"
                )

            where_clause = " AND ".join(conditions)
            params.extend([limit, skip])

            rows = await conn.fetch(
                f"""
                SELECT *, COUNT(*) OVER() AS full_count
                FROM receipts
                WHERE {where_clause}
                ORDER BY created_at DESC
                LIMIT ${param_idx} OFFSET ${param_idx + 1}
                """,
                *params,
            )
            total = rows[0]["full_count"] if rows else 0
            # Batch-load items for all returned receipts (single query)
            receipt_ids = [r["id"] for r in rows]
            items_map = {}
            if receipt_ids:
                item_rows = await conn.fetch(
                    """
                    SELECT receipt_id, sort_order, name, quantity, price, tax, is_zero_rated, discount
                    FROM line_items
                    WHERE receipt_id = ANY($1::text[])
                    ORDER BY receipt_id, sort_order
                    """,
                    receipt_ids,
                )
                for ir in item_rows:
                    rid = ir["receipt_id"]
                    if rid not in items_map:
                        items_map[rid] = []
                    items_map[rid].append({
                        "name": ir["name"],
                        "quantity": float(ir["quantity"]),
                        "price": format(Decimal(str(ir["price"])), ".2f"),
                        "tax": format(Decimal(str(ir["tax"] or 0)), ".2f"),
                        "isZeroRated": ir["is_zero_rated"],
                        "discount": format(Decimal(str(ir["discount"])), ".2f") if ir["discount"] else None,
                    })

            receipts = [_receipt_row_to_dict(r, items_map.get(r["id"], [])) for r in rows]
            return receipts, total

    @staticmethod
    async def update_receipt(
        user_id: str, receipt_id: str, receipt_data: Dict[str, Any]
    ) -> bool:
        """Update receipt fields.  If items are provided, replace all items."""
        now = datetime.now(timezone.utc)

        date_val = receipt_data.get("receiptDate")
        if date_val:
            receipt_date = _parse_date_mmddyyyy(date_val) or now.date()
        else:
            receipt_date = None

        total = None
        if "totalAmount" in receipt_data:
            total = sanitize_numeric(receipt_data["totalAmount"])

        tax = None
        if "taxAmount" in receipt_data:
            tax = sanitize_numeric(receipt_data["taxAmount"])

        pool = await get_pool()
        async with pool.acquire() as conn:
            async with conn.transaction():
                result = await conn.execute(
                    """
                    UPDATE receipts SET
                        status = COALESCE($3, status),
                        supplier = COALESCE($4, supplier),
                        total_amount = COALESCE($5, total_amount),
                        tax_amount = $6,
                        receipt_date = COALESCE($7, receipt_date),
                        category = COALESCE($8, category),
                        invoice_number = COALESCE($9, invoice_number),
                        kra_pin = COALESCE($10, kra_pin),
                        cu_invoice = COALESCE($11, cu_invoice),
                        batch_title = COALESCE($12, batch_title),
                        image_filename = COALESCE($13, image_filename),
                        updated_at = $14
                    WHERE id = $1 AND user_id = $2
                    """,
                    receipt_id,
                    user_id,
                    receipt_data.get("status"),
                    receipt_data.get("supplier"),
                    total,
                    tax,
                    receipt_date,
                    receipt_data.get("category"),
                    receipt_data.get("invoiceNumber"),
                    receipt_data.get("kraPin"),
                    receipt_data.get("cuInvoice"),
                    receipt_data.get("batchTitle"),
                    receipt_data.get("image_filename"),
                    now,
                )

                if result == "UPDATE 0":
                    return False

                # Replace items if provided
                if "items" in receipt_data:
                    await conn.execute(
                        "DELETE FROM line_items WHERE receipt_id = $1", receipt_id
                    )
                    items = receipt_data["items"] or []
                    if items:
                        await conn.executemany(
                            """
                            INSERT INTO line_items (receipt_id, sort_order, name, quantity,
                                price, tax, is_zero_rated, discount)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                            """,
                            [
                                (
                                    receipt_id,
                                    i,
                                    item.get("name", "N/A"),
                                    float(item.get("quantity", 1)),
                                    sanitize_numeric(item.get("price", "0")),
                                    sanitize_numeric(item.get("tax", "0")),
                                    item.get("isZeroRated", False),
                                    _to_numeric(item.get("discount")),
                                )
                                for i, item in enumerate(items)
                            ],
                        )

                return True

    @staticmethod
    async def delete_receipt(user_id: str, receipt_id: str) -> bool:
        """Delete receipt + CASCADE deletes items."""
        pool = await get_pool()
        async with pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM receipts WHERE id = $1 AND user_id = $2",
                receipt_id, user_id,
            )
            return result == "DELETE 1"

    @staticmethod
    async def search_receipts(
        user_id: str,
        supplier: Optional[str] = None,
        category: Optional[str] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Search receipts with optional filters."""
        pool = await get_pool()
        async with pool.acquire() as conn:
            params = [user_id]
            conditions = ["user_id = $1"]
            p = 2

            if supplier:
                params.append(supplier)
                conditions.append(f"supplier = ${p}")
                p += 1
            if category:
                params.append(category)
                conditions.append(f"category = ${p}")
                p += 1
            if date_from:
                d = _parse_date_mmddyyyy(date_from)
                if d:
                    params.append(d)
                    conditions.append(f"receipt_date >= ${p}::date")
                    p += 1
            if date_to:
                d = _parse_date_mmddyyyy(date_to)
                if d:
                    params.append(d)
                    conditions.append(f"receipt_date <= ${p}::date")
                    p += 1

            where = " AND ".join(conditions)
            rows = await conn.fetch(
                f"""
                SELECT * FROM receipts
                WHERE {where}
                ORDER BY receipt_date DESC
                """,
                *params,
            )
            return [_receipt_row_to_dict(r) for r in rows]

    @staticmethod
    async def check_duplicate(
        user_id: str,
        supplier: Optional[str] = None,
        totalAmount: Optional[str] = None,
        receiptDate: Optional[str] = None,
        invoiceNumber: Optional[str] = None,
        exclude_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Check for duplicate receipts."""
        pool = await get_pool()
        async with pool.acquire() as conn:
            results = []
            exclude_uuid = exclude_id or "00000000-0000-0000-0000-000000000000"

            if invoiceNumber:
                rows = await conn.fetch(
                    """
                    SELECT * FROM receipts
                    WHERE user_id = $1 AND invoice_number = $2 AND id != $3
                    """,
                    user_id, invoiceNumber, exclude_uuid,
                )
                for r in rows:
                    d = _receipt_row_to_dict(r)
                    d["_confidence"] = "high"
                    results.append(d)

            if supplier and totalAmount:
                date_val = _parse_date_mmddyyyy(receiptDate) if receiptDate else None
                amount = sanitize_numeric(totalAmount)
                rows = await conn.fetch(
                    """
                    SELECT * FROM receipts
                    WHERE user_id = $1 AND supplier = $2
                      AND total_amount = $3::numeric
                      AND id != $4
                    """,
                    user_id, supplier, amount, exclude_uuid,
                )
                seen = {r["id"] for r in results if "id" in r}
                for r in rows:
                    rid = str(r["id"])
                    if rid in seen:
                        continue
                    d = _receipt_row_to_dict(r)
                    if date_val and r["receipt_date"] == date_val:
                        d["_confidence"] = "high"
                    else:
                        d["_confidence"] = "medium"
                    results.append(d)
                    seen.add(rid)

            return results

    @staticmethod
    async def get_receipt_groups(user_id: str) -> List[Dict[str, Any]]:
        """Return receipts grouped by batchTitle for gallery browsing."""
        pool = await get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT
                    COALESCE(NULLIF(TRIM(batch_title), ''), 'Ungrouped') AS "batchTitle",
                    COUNT(*) AS count,
                    MIN('/receipt-images/' || id::text) AS "thumbnailUrl",
                    COALESCE(SUM(total_amount), 0) AS "totalAmount",
                    MAX(receipt_date::text) AS "latestDate",
                    MIN(supplier) AS "firstSupplier"
                FROM receipts
                WHERE user_id = $1
                  AND image_filename IS NOT NULL
                GROUP BY "batchTitle"
                ORDER BY count DESC
                """,
                user_id,
            )
            groups = []
            for r in rows:
                total = r["totalAmount"]
                groups.append({
                    "batchTitle": r["batchTitle"],
                    "count": r["count"],
                    "thumbnailUrl": r["thumbnailUrl"],
                    "totalAmount": float(total) if total else 0.0,
                    "latestDate": r["latestDate"],
                    "firstSupplier": r["firstSupplier"],
                })
            return groups


# ═══════════════════════════════════════════════════════════════════════════
# Image storage helpers (local filesystem)
# ═══════════════════════════════════════════════════════════════════════════

def save_image(receipt_id: str, jpeg_bytes: bytes) -> str:
    """Save full JPEG to disk.  Returns the filename."""
    os.makedirs(settings.IMAGE_STORAGE_DIR, exist_ok=True)
    filename = f"{receipt_id}.jpg"
    path = os.path.join(settings.IMAGE_STORAGE_DIR, filename)
    with open(path, "wb") as f:
        f.write(jpeg_bytes)
    logger.info("Saved image %s (%d KB)", filename, len(jpeg_bytes) // 1024)
    return filename


def save_thumbnail(receipt_id: str, jpeg_bytes: bytes) -> str:
    """Save thumbnail JPEG to disk."""
    os.makedirs(settings.IMAGE_STORAGE_DIR, exist_ok=True)
    filename = f"{receipt_id}_thumb.jpg"
    path = os.path.join(settings.IMAGE_STORAGE_DIR, filename)
    with open(path, "wb") as f:
        f.write(jpeg_bytes)
    logger.info("Saved thumbnail %s (%d KB)", filename, len(jpeg_bytes) // 1024)
    return filename


def delete_receipt_images(receipt_id: str) -> None:
    """Remove image + thumbnail files for a receipt."""
    for suffix in (".jpg", "_thumb.jpg"):
        path = os.path.join(settings.IMAGE_STORAGE_DIR, f"{receipt_id}{suffix}")
        try:
            os.remove(path)
            logger.info("Deleted %s", os.path.basename(path))
        except FileNotFoundError:
            pass
        except Exception:
            logger.warning("Failed to delete %s", path, exc_info=True)


def read_image(receipt_id: str, thumb: bool = False) -> Optional[bytes]:
    """Read an image file from disk.  Returns None if not found."""
    suffix = "_thumb.jpg" if thumb else ".jpg"
    path = os.path.join(settings.IMAGE_STORAGE_DIR, f"{receipt_id}{suffix}")
    try:
        with open(path, "rb") as f:
            return f.read()
    except FileNotFoundError:
        return None
