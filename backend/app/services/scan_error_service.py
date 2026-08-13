"""
Persistent, user-reviewable log of failed extraction / batch runs.

The Redis batch state is the live view of an in-progress scan but expires
after 24h, so a failed batch can vanish without the user ever understanding
what happened.  scan_errors is the durable counterpart: the worker writes
one record per failed chunk (and batches of failed items) and the frontend
surfaces them via toast + a bell / notifications page that stays visible
until the user dismisses it.

Every record is scoped by user_id.  The API and service always filter by
user_id explicitly, and the table is registered with RLS in core/database.py.
"""
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from app.core.database import get_pool

logger = logging.getLogger(__name__)


def _row_to_dict(row) -> Dict[str, Any]:
    data = row["data"]
    if isinstance(data, str):
        try:
            data = json.loads(data) if data else {}
        except json.JSONDecodeError:
            data = {}
    created_at = row["created_at"]
    return {
        "id": str(row["id"]),
        "kind": row["kind"],
        "code": row["code"],
        "message": row["message"],
        "title": row["title"],
        "batch_id": row["batch_id"],
        "item_index": row["item_index"],
        "receipt_id": row["receipt_id"],
        "data": data or {},
        "read": row["read_at"] is not None,
        "created_at": created_at.timestamp() if created_at else None,
    }


async def log_error(
    user_id: str,
    *,
    kind: str = "batch",
    code: str = "UNKNOWN",
    message: str,
    title: Optional[str] = None,
    batch_id: Optional[str] = None,
    item_index: Optional[int] = None,
    receipt_id: Optional[str] = None,
    data: Optional[Dict[str, Any]] = None,
) -> Optional[str]:
    """Persist one error record. Best-effort — never raises so logging a
    failure can't itself crash a worker task."""
    try:
        error_id = str(uuid.uuid4())
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO scan_errors
                    (id, user_id, kind, code, message, title, batch_id,
                     item_index, receipt_id, data)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
                """,
                error_id,
                user_id,
                kind,
                code,
                message[:2000],
                (title or "")[:500] or None,
                batch_id,
                item_index,
                receipt_id,
                json.dumps(data or {}, default=str),
            )
        return error_id
    except Exception:
        logger.exception("Failed to persist scan_error for user %s", user_id)
        return None


async def list_errors(user_id: str, limit: int = 100) -> List[Dict[str, Any]]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, kind, code, message, title, batch_id, item_index,
                   receipt_id, data, read_at, created_at
            FROM scan_errors
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT $2
            """,
            user_id,
            limit,
        )
        return [_row_to_dict(r) for r in rows]


async def unread_count(user_id: str) -> int:
    pool = await get_pool()
    async with pool.acquire() as conn:
        return await conn.fetchval(
            "SELECT count(*) FROM scan_errors WHERE user_id = $1 AND read_at IS NULL",
            user_id,
        )


async def mark_read(user_id: str, error_id: str) -> bool:
    pool = await get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            UPDATE scan_errors
            SET read_at = COALESCE(read_at, now())
            WHERE id = $1 AND user_id = $2
            """,
            error_id,
            user_id,
        )
        return result == "UPDATE 1"


async def mark_all_read(user_id: str) -> int:
    pool = await get_pool()
    async with pool.acquire() as conn:
        result = await conn.fetchval(
            """
            SELECT count(*) FROM scan_errors
            WHERE user_id = $1 AND read_at IS NULL
            """,
            user_id,
        )
        if result:
            await conn.execute(
                "UPDATE scan_errors SET read_at = now() WHERE user_id = $1 AND read_at IS NULL",
                user_id,
            )
        return result or 0


async def delete_error(user_id: str, error_id: str) -> bool:
    pool = await get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM scan_errors WHERE id = $1 AND user_id = $2",
            error_id,
            user_id,
        )
        return result == "DELETE 1"


async def clear_all(user_id: str) -> int:
    pool = await get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM scan_errors WHERE user_id = $1",
            user_id,
        )
        # result looks like "DELETE 17"
        parts = result.split(" ")
        return int(parts[1]) if len(parts) == 2 else 0