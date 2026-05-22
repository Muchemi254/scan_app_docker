"""
PostgreSQL-backed review batch service.

Tracks which receipts are in a review batch and their per-receipt review
status.  The actual receipt data lives in the receipts table — this is
only a lightweight overlay for the manual-review workflow.

Migrated from SQLite to asyncpg/PostgreSQL.  All function signatures
are async and return the same dict shapes.
"""

import logging
import uuid
from datetime import datetime, timezone
from typing import Optional, List

from app.core.database import get_pool

logger = logging.getLogger(__name__)


async def init_db():
    """No-op: schema is managed by Alembic.  Kept for backward compat."""
    pass


# ═══════════════════════════════════════════════════════════════════════════
# Batch CRUD
# ═══════════════════════════════════════════════════════════════════════════

async def create_batch(
    user_id: str, name: str, receipt_ids: list[str],
    csv_filename: Optional[str] = None,
) -> dict:
    """Create a new review batch with the given receipt IDs."""
    batch_id = uuid.uuid4().hex[:12]
    now = datetime.now(timezone.utc)

    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """
                INSERT INTO review_batches (id, user_id, name, csv_filename, created_at, updated_at)
                VALUES ($1, $2, $3, $4, $5, $5)
                """,
                batch_id, user_id, name, csv_filename, now,
            )
            for rid in receipt_ids:
                try:
                    await conn.execute(
                        """
                        INSERT INTO review_batch_items (batch_id, receipt_id, review_status)
                        VALUES ($1, $2, 'pending_review')
                        ON CONFLICT (batch_id, receipt_id) DO NOTHING
                        """,
                        batch_id, rid.strip(),
                    )
                except Exception:
                    pass

        return {
            "id": batch_id, "user_id": user_id, "name": name,
            "csv_filename": csv_filename, "receipt_count": len(receipt_ids),
            "created_at": now.isoformat(), "updated_at": now.isoformat(),
        }


async def list_batches(user_id: str) -> list[dict]:
    """List all review batches for a user with item counts by status."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT * FROM review_batches
            WHERE user_id = $1
            ORDER BY created_at DESC
            """,
            user_id,
        )
        batches = []
        for r in rows:
            b = dict(r)
            b["created_at"] = b["created_at"].isoformat() if b.get("created_at") else None
            b["updated_at"] = b["updated_at"].isoformat() if b.get("updated_at") else None

            stats = await conn.fetch(
                """
                SELECT review_status, COUNT(*) AS cnt
                FROM review_batch_items
                WHERE batch_id = $1
                GROUP BY review_status
                """,
                b["id"],
            )
            b["status_counts"] = {s["review_status"]: s["cnt"] for s in stats}
            b["total_items"] = sum(b["status_counts"].values())
            batches.append(b)
        return batches


async def get_batch(user_id: str, batch_id: str) -> Optional[dict]:
    """Get a single batch with its items."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM review_batches WHERE id = $1 AND user_id = $2",
            batch_id, user_id,
        )
        if not row:
            return None
        b = dict(row)
        b["created_at"] = b["created_at"].isoformat() if b.get("created_at") else None
        b["updated_at"] = b["updated_at"].isoformat() if b.get("updated_at") else None

        items = await conn.fetch(
            "SELECT * FROM review_batch_items WHERE batch_id = $1 ORDER BY id",
            batch_id,
        )
        b["items"] = [dict(i) for i in items]
        for item in b["items"]:
            if item.get("reviewed_at"):
                item["reviewed_at"] = item["reviewed_at"].isoformat()
        return b


async def delete_batch(user_id: str, batch_id: str) -> bool:
    """Delete a batch and its items (CASCADE)."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM review_batches WHERE id = $1 AND user_id = $2",
            batch_id, user_id,
        )
        return "DELETE 1" in result


# ═══════════════════════════════════════════════════════════════════════════
# Per-item review status
# ═══════════════════════════════════════════════════════════════════════════

async def update_item_status(
    batch_id: str, receipt_id: str, review_status: str,
    notes: Optional[str] = None,
) -> Optional[dict]:
    """Update the review status of a single receipt in a batch."""
    now = datetime.now(timezone.utc) if review_status == "reviewed" else None

    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """
                UPDATE review_batch_items
                SET review_status = $3, reviewer_notes = $4,
                    reviewed_at = COALESCE($5, reviewed_at)
                WHERE batch_id = $1 AND receipt_id = $2
                """,
                batch_id, receipt_id, review_status, notes, now,
            )
            await conn.execute(
                "UPDATE review_batches SET updated_at = $2 WHERE id = $1",
                batch_id, datetime.now(timezone.utc),
            )
            row = await conn.fetchrow(
                "SELECT * FROM review_batch_items WHERE batch_id = $1 AND receipt_id = $2",
                batch_id, receipt_id,
            )
            if not row:
                return None
            result = dict(row)
            if result.get("reviewed_at"):
                result["reviewed_at"] = result["reviewed_at"].isoformat()
            return result


async def delete_item(batch_id: str, receipt_id: str) -> bool:
    """Remove a single receipt from a batch."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            result = await conn.execute(
                "DELETE FROM review_batch_items WHERE batch_id = $1 AND receipt_id = $2",
                batch_id, receipt_id,
            )
            await conn.execute(
                "UPDATE review_batches SET updated_at = $2 WHERE id = $1",
                batch_id, datetime.now(timezone.utc),
            )
            return "DELETE 1" in result


async def get_item_status(batch_id: str, receipt_id: str) -> Optional[dict]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM review_batch_items WHERE batch_id = $1 AND receipt_id = $2",
            batch_id, receipt_id,
        )
        if not row:
            return None
        result = dict(row)
        if result.get("reviewed_at"):
            result["reviewed_at"] = result["reviewed_at"].isoformat()
        return result
