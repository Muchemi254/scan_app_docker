"""
Batch scanning service — durable Postgres-backed scan sessions.

Replaces the old Redis batch state. A scan session (and its per-image rows)
survive indefinitely, so a user can upload + locally prep thousands of
images, hold them in `prepared` state, then dispatch any group to AI days or
weeks later — no re-upload, no re-optimization, and the same image can never
be sent twice (sha256 + per-item state machine).

Redis is no longer involved in scan state. The `get_redis`/`close_redis`
helpers are kept ONLY for the other features that still use them
(image cache, review-batch cache, shutdown hooks).

DB schema:
  scan_sessions (id, user_id, title, status, image_count, group_count,
                 chunks jsonb, created_at, updated_at)
  scan_session_items (id, session_id, item_index, orig_filename,
                 image_filename, mime, image_sha256, group_index, chunk_index,
                 status, stage, message, error_code, error_message, receipt_id,
                 attempts, created_at, updated_at)

Item statuses: pending | optimizing | prepared | extracting | done |
               needs_review | failed | duplicate
Session statuses: uploading | prepared | processing | done | failed
"""

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

import redis.asyncio as aioredis

from app.core.config import settings
from app.core.database import get_pool

logger = logging.getLogger(__name__)


# ─── Redis connection (kept for OTHER features — not scan state) ────────────

# Cache (loop, client) tuples keyed by id(loop). The loop reference is kept so
# we can detect id() reuse — Python re-assigns object ids after GC, and Celery
# creates a fresh event loop per task via asyncio.run(). Without the identity
# check, task N+1 can pick up task N's dead client and crash with
# "Event loop is closed".
_redis_cache: Dict[int, Tuple[asyncio.AbstractEventLoop, aioredis.Redis]] = {}


async def get_redis() -> aioredis.Redis:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # Fallback for non-async contexts (shouldn't happen in practice)
        return aioredis.from_url(settings.REDIS_URL, decode_responses=True)

    loop_id = id(loop)
    cached = _redis_cache.get(loop_id)
    if cached is not None:
        cached_loop, cached_client = cached
        # Identity check catches id() reuse after GC; is_closed() catches the
        # rarer case where someone closed the loop without dropping the cache.
        if cached_loop is loop and not loop.is_closed():
            return cached_client
        # Stale — pop and recreate.
        _redis_cache.pop(loop_id, None)
        logger.info(f"Dropping stale Redis client for reused loop id {loop_id}")

    logger.info(f"Creating new Redis client for event loop {loop_id}")
    pool = aioredis.ConnectionPool.from_url(settings.REDIS_URL, decode_responses=True)
    client = aioredis.Redis(connection_pool=pool)
    _redis_cache[loop_id] = (loop, client)
    return client


async def close_redis() -> None:
    """Close the Redis client for the current loop and remove from cache."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    loop_id = id(loop)
    cached = _redis_cache.pop(loop_id, None)
    if cached is None:
        return
    _, client = cached
    try:
        await client.aclose()
        await client.connection_pool.disconnect()
    except Exception as e:
        logger.warning(f"close_redis: failed to close cleanly for loop {loop_id}: {e}")


# ─── Helpers ────────────────────────────────────────────────────────────────


def _now() -> float:
    return datetime.now(timezone.utc).timestamp()


def _epoch(ts) -> float:
    """DB timestamptz → epoch seconds (matches the old Redis float format)."""
    if not ts:
        return 0.0
    if isinstance(ts, (int, float)):
        return float(ts)
    try:
        return ts.timestamp()
    except Exception:
        return 0.0


def _row_to_item(r) -> dict:
    """scan_session_items row → the dict shape the API/frontend expect."""
    return {
        "index": r["item_index"],
        "filename": r["image_filename"] or r["orig_filename"] or "",
        "origFilename": r["orig_filename"],
        "mime": r["mime"],
        "sha256": r["image_sha256"],
        "status": r["status"],
        "stage": r["stage"],
        "chunkIndex": r["chunk_index"],
        "receiptId": r["receipt_id"],
        "message": r["message"],
        "errorCode": r["error_code"],
        "groupIndex": r["group_index"],
        "updatedAt": _epoch(r["updated_at"]),
    }


# ─── Batch/session CRUD ─────────────────────────────────────────────────────


async def create_batch(user_id: str, batch_title: str, filenames: List[str]) -> str:
    """Create a durable scan session + one item row per file.

    Items start in `pending`; they become `prepared` after local optimization
    in the upload/process endpoint. Returns the session (batch) id.
    """
    session_id = uuid.uuid4().hex
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """
                INSERT INTO scan_sessions (id, user_id, title, status, image_count, group_count, chunks)
                VALUES ($1, $2, $3, 'uploading', 0, 0, '[]'::jsonb)
                """,
                session_id, user_id, batch_title,
            )
            await conn.executemany(
                """
                INSERT INTO scan_session_items
                    (id, session_id, user_id, item_index, orig_filename, image_filename, mime, group_index, status, stage)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', 'queued')
                """,
                [
                    (uuid.uuid4().hex, session_id, user_id, i, fn, None, None, 0)
                    for i, fn in enumerate(filenames)
                ],
            )
    return session_id


async def get_user_batches(user_id: str) -> List[str]:
    """All scan session ids for a user (durable — never expires)."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id FROM scan_sessions WHERE user_id = $1 ORDER BY created_at DESC",
            user_id,
        )
        return [str(r["id"]) for r in rows]


TRANSIENT_ITEM_STATUSES = {"pending", "optimizing", "extracting"}


def derive_session_status(batch: dict) -> str:
    """Session status derived from item states (source of truth after prep).

    A dispatched group finishing must NOT mark the whole session terminal
    while other groups are still held as `prepared` — otherwise those held
    groups could never be sent ({groupId} → 'batch already done'). So
    `prepared` outranks `done` until every held image has been dispatched.
    """
    statuses = [i.get("status") for i in (batch.get("items") or [])]
    if any(s in TRANSIENT_ITEM_STATUSES for s in statuses):
        return "processing"                # something is in flight
    if "prepared" in statuses:
        return "prepared"                  # held work remains — still dispatchable
    if any(s in ("done", "needs_review", "duplicate") for s in statuses):
        return "done"                      # everything dispatched, at least one saved
    if statuses:
        return "failed"                    # everything failed
    return batch.get("status") or "prepared"


async def _reconcile_session_status(batch: dict) -> None:
    """Persist the canonical session status if it drifted from item states."""
    if batch["status"] == "uploading":
        return
    derived = derive_session_status(batch)
    if derived != batch["status"]:
        await set_batch_status(batch["userId"], batch["batchId"], derived)
        batch["status"] = derived


async def get_batch(user_id: str, batch_id: str) -> Optional[dict]:
    """Load a scan session + items, shaped like the old Redis batch object."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM scan_sessions WHERE id = $1 AND user_id = $2",
            batch_id, user_id,
        )
        if not row:
            return None
        items = await conn.fetch(
            "SELECT * FROM scan_session_items WHERE session_id = $1 ORDER BY item_index",
            batch_id,
        )
    chunks = row["chunks"] or []
    if isinstance(chunks, str):
        chunks = json.loads(chunks)
    result = {
        "batchId": str(row["id"]),
        "userId": str(row["user_id"]),
        "batchTitle": row["title"],
        "status": row["status"],
        "imageCount": row["image_count"],
        "groupCount": row["group_count"],
        "createdAt": _epoch(row["created_at"]),
        "lastActivity": _epoch(row["updated_at"]),
        "items": [_row_to_item(r) for r in items],
        "chunks": chunks,
    }
    await _reconcile_session_status(result)
    return result


async def set_batch_status(user_id: str, batch_id: str, status: str) -> None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE scan_sessions SET status = $1, updated_at = now() WHERE id = $2 AND user_id = $3",
            status, batch_id, user_id,
        )


async def update_item(
    user_id: str,
    batch_id: str,
    index: int,
    status: str,
    receipt_id: Optional[str] = None,
    message: Optional[str] = None,
    stage: Optional[str] = None,
    chunk_index: Optional[int] = None,
    error_code: Optional[str] = None,
    orig_filename: Optional[str] = None,
) -> None:
    """Update a single item's durable state."""
    pool = await get_pool()
    if status in ("done", "needs_review", "duplicate"):
        error_code = None
    error_message_final = message if status in ("failed",) else None
    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                "SELECT 1 FROM scan_sessions WHERE id = $1 AND user_id = $2",
                batch_id, user_id,
            )
            if not row:
                return
            await conn.execute(
                """
                UPDATE scan_session_items SET
                    status = $3,
                    receipt_id = COALESCE($4, receipt_id),
                    message = COALESCE($5, message),
                    stage = COALESCE($6, stage),
                    chunk_index = COALESCE($7, chunk_index),
                    error_code = $8,
                    error_message = $9,
                    orig_filename = COALESCE($10, orig_filename),
                    updated_at = now()
                WHERE session_id = $1 AND item_index = $2
                """,
                batch_id, index,
                status, receipt_id, message, stage, chunk_index,
                error_code, error_message_final, orig_filename,
            )


async def init_chunks(
    user_id: str,
    batch_id: str,
    chunks: List[Dict],
) -> None:
    """Set the runtime chunk list (Gemini batching) + tag items with chunk_index."""
    pool = await get_pool()
    chunk_meta = [
        {
            "index": c["index"],
            "itemRange": c["itemRange"],
            "size": c["size"],
            "status": "pending",
            "attempts": 0,
            "errorCode": None,
            "errorMessage": None,
            "startedAt": None,
            "completedAt": None,
        }
        for c in chunks
    ]
    async with pool.acquire() as conn:
        async with conn.transaction():
            await conn.execute(
                """
                UPDATE scan_sessions SET chunks = $1::jsonb, updated_at = now()
                WHERE id = $2 AND user_id = $3
                """,
                json.dumps(chunk_meta), batch_id, user_id,
            )
            for c in chunks:
                lo, hi = c["itemRange"]
                await conn.execute(
                    """
                    UPDATE scan_session_items SET chunk_index = $1, updated_at = now()
                    WHERE session_id = $2 AND item_index BETWEEN $3 AND $4
                    """,
                    c["index"], batch_id, lo, hi,
                )


async def update_chunk(
    user_id: str,
    batch_id: str,
    chunk_index: int,
    *,
    status: Optional[str] = None,
    increment_attempts: bool = False,
    error_code: Optional[str] = None,
    error_message: Optional[str] = None,
    started: bool = False,
    completed: bool = False,
) -> None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT chunks FROM scan_sessions WHERE id = $1 AND user_id = $2",
            batch_id, user_id,
        )
        if not row:
            return
        chunks = row["chunks"] or []
        if isinstance(chunks, str):
            chunks = json.loads(chunks)
        chunk = next((c for c in chunks if c["index"] == chunk_index), None)
        if chunk is None:
            return
        if status is not None:
            chunk["status"] = status
        if increment_attempts:
            chunk["attempts"] = (chunk.get("attempts") or 0) + 1
        if error_code is not None:
            chunk["errorCode"] = error_code
        if error_message is not None:
            chunk["errorMessage"] = error_message
        if started and not chunk.get("startedAt"):
            chunk["startedAt"] = _now()
        if completed:
            chunk["completedAt"] = _now()
        if status in ("done",):
            chunk["errorCode"] = None
            chunk["errorMessage"] = None
        await conn.execute(
            "UPDATE scan_sessions SET chunks = $1::jsonb, updated_at = now() WHERE id = $2",
            json.dumps(chunks), batch_id,
        )


async def delete_batch(user_id: str, batch_id: str) -> None:
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "DELETE FROM scan_sessions WHERE id = $1 AND user_id = $2",
            batch_id, user_id,
        )


async def remove_batches_from_index(user_id: str, batch_ids) -> None:
    """No-op — sessions never expire in Postgres. Kept for API compatibility."""
    return


# ─── Prepping helpers (upload → prepared) ────────────────────────────────────


async def set_prepared(
    user_id: str,
    batch_id: str,
    index: int,
    *,
    image_filename: str,
    mime: str,
    sha256: str,
    orig_filename: Optional[str],
    group_index: int,
) -> None:
    """Record that a locally-processed image is ready, waiting for dispatch."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT 1 FROM scan_sessions WHERE id = $1 AND user_id = $2",
            batch_id, user_id,
        )
        if not row:
            return
        await conn.execute(
            """
            UPDATE scan_session_items SET
                status = 'prepared', stage = 'done',
                message = 'Prepared — ready for AI',
                image_filename = $3, mime = $4, image_sha256 = $5,
                orig_filename = COALESCE($6, orig_filename),
                group_index = $7,
                error_code = NULL, error_message = NULL,
                updated_at = now()
            WHERE session_id = $1 AND item_index = $2
            """,
            batch_id, index, image_filename, mime, sha256,
            orig_filename, group_index,
        )


async def finalize_prepared(
    user_id: str, batch_id: str, prepared_count: int, group_count: int
) -> None:
    """Flip a session to `prepared` (holding) once local prep is done."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE scan_sessions SET status = 'prepared', image_count = $3,
                group_count = $4, updated_at = now()
            WHERE id = $1 AND user_id = $2
            """,
            batch_id, user_id, prepared_count, group_count,
        )


# ─── Dispatch helpers (hold → send) ─────────────────────────────────────────

def _matches_filter(item: dict, groups, items_filter, all_) -> bool:
    if all_:
        return True
    in_groups = groups is not None and item.get("groupIndex") in groups
    in_items = items_filter is not None and item.get("index") in items_filter
    return in_groups or in_items


async def get_dispatch_items(
    user_id: str,
    batch_id: str,
    *,
    groups: Optional[List[int]] = None,
    items: Optional[List[int]] = None,
    all_: bool = False,
) -> List[dict]:
    """Return prepared items in a session matching the dispatch filter.

    Only items with status='prepared' are eligible — already-sent or
    completed images are never re-dispatched (idempotency by construction).
    """
    batch = await get_batch(user_id, batch_id)
    if not batch:
        return []
    eligible = [i for i in batch["items"] if i["status"] == "prepared"]
    if all_:
        return eligible
    if groups is None and items is None:
        return []
    return [i for i in eligible if _matches_filter(i, groups, items, False)]


async def mark_queued(user_id: str, batch_id: str, indexes: List[int]) -> List[int]:
    """Flip selected prepared items back to `pending` for dispatch.

    Atomic per item (`status = 'prepared'` guard) so concurrent dispatches of
    the same group can't double-send: only items still prepared are flipped,
    and the actually-flipped indexes are returned for the enqueue step.
    """
    if not indexes:
        return []
    pool = await get_pool()
    async with pool.acquire() as conn:
        async with conn.transaction():
            rows = await conn.fetch(
                """
                UPDATE scan_session_items
                SET status = 'pending', stage = 'queued', message = 'Ready for AI',
                    error_code = NULL, error_message = NULL, updated_at = now()
                WHERE session_id = $1 AND item_index = ANY($2::int[]) AND status = 'prepared'
                RETURNING item_index
                """,
                batch_id, [int(i) for i in indexes],
            )
            flipped = sorted(r["item_index"] for r in rows)
    return flipped
