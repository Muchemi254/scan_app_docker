"""
Batch scanning service.

Manages batch state in Redis so that:
 - Processing runs entirely on the backend (survives frontend refresh/navigation)
 - Frontend can reconnect to an in-progress batch by batchId
 - State is visible across devices logged in as the same user

Redis schema (key = batch:{userId}:{batchId}):
  {
    "batchId": str,
    "userId": str,
    "batchTitle": str,
    "status": "uploading" | "processing" | "done" | "failed",
    "createdAt": float,
    "lastActivity": float,
    "items": [
      {
        "index": int,
        "filename": str,
        "origFilename": str | null,
        "status": "pending" | "optimizing" | "processing" | "done" | "needs_review" | "failed" | "duplicate",
        "stage": "queued" | "optimizing" | "extracting" | "parsing" | "saving" | "done",
        "chunkIndex": int | null,
        "receiptId": str | null,
        "message": str | null,
        "errorCode": str | null
      }
    ],
    "chunks": [
      {
        "index": int,
        "itemRange": [int, int],   # inclusive-inclusive
        "size": int,
        "status": "pending" | "extracting" | "saving" | "done" | "failed",
        "attempts": int,
        "errorCode": str | null,
        "errorMessage": str | null,
        "startedAt": float | null,
        "completedAt": float | null
      }
    ]
  }
"""

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

import redis.asyncio as aioredis

from app.core.config import settings

logger = logging.getLogger(__name__)

BATCH_TTL = 60 * 60 * 24  # 24 hours

# ─── Redis connection ────────────────────────────────────────────────────────

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
    """Close the Redis client for the current loop and remove from cache.

    Narrow exception handling so future failures are visible — the previous
    bare `except: pass` silently swallowed the cleanup failures that allowed
    stale cache entries to survive into the next Celery task.
    """
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


# ─── Batch CRUD ─────────────────────────────────────────────────────────────


def _now() -> float:
    return datetime.now(timezone.utc).timestamp()


async def create_batch(user_id: str, batch_title: str, filenames: List[str]) -> str:
    r = await get_redis()
    batch_id = str(uuid.uuid4())
    now = _now()
    data = {
        "batchId": batch_id,
        "userId": user_id,
        "batchTitle": batch_title,
        "status": "uploading",
        "createdAt": now,
        "lastActivity": now,
        "items": [
            {
                "index": i,
                "filename": fn,
                "origFilename": fn,
                "status": "pending",
                "stage": "queued",
                "chunkIndex": None,
                "receiptId": None,
                "message": None,
                "errorCode": None,
            }
            for i, fn in enumerate(filenames)
        ],
        "chunks": [],
    }
    # Namespace batch key by user for isolation
    await r.setex(f"batch:{user_id}:{batch_id}", BATCH_TTL, json.dumps(data))
    await r.sadd(f"user_batches:{user_id}", batch_id)
    return batch_id


async def get_user_batches(user_id: str) -> List[str]:
    """Get all batch IDs for a user."""
    r = await get_redis()
    return await r.smembers(f"user_batches:{user_id}")


async def get_batch(user_id: str, batch_id: str) -> Optional[dict]:
    r = await get_redis()
    raw = await r.get(f"batch:{user_id}:{batch_id}")
    if not raw:
        return None
    return json.loads(raw)


async def set_batch_status(user_id: str, batch_id: str, status: str) -> None:
    r = await get_redis()
    raw = await r.get(f"batch:{user_id}:{batch_id}")
    if not raw:
        return
    data = json.loads(raw)
    data["status"] = status
    data["lastActivity"] = _now()
    await r.setex(f"batch:{user_id}:{batch_id}", BATCH_TTL, json.dumps(data))


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
    """Update fields on a single batch item.

    `status` is required so callers always make a clear state transition;
    everything else is optional and only overwrites when explicitly passed.
    """
    r = await get_redis()
    raw = await r.get(f"batch:{user_id}:{batch_id}")
    if not raw:
        return
    data = json.loads(raw)
    if index < 0 or index >= len(data["items"]):
        return
    item = data["items"][index]
    item["status"] = status
    if receipt_id is not None:
        item["receiptId"] = receipt_id
    if message is not None:
        item["message"] = message
    if stage is not None:
        item["stage"] = stage
    if chunk_index is not None:
        item["chunkIndex"] = chunk_index
    if error_code is not None:
        item["errorCode"] = error_code
    if orig_filename is not None:
        item["origFilename"] = orig_filename
    if status in ("done", "needs_review", "duplicate"):
        item["errorCode"] = None
    data["lastActivity"] = _now()
    await r.setex(f"batch:{user_id}:{batch_id}", BATCH_TTL, json.dumps(data))


async def init_chunks(
    user_id: str,
    batch_id: str,
    chunks: List[Dict],
) -> None:
    """Set the chunks array for a batch. Each chunk dict needs index, itemRange, size."""
    r = await get_redis()
    raw = await r.get(f"batch:{user_id}:{batch_id}")
    if not raw:
        return
    data = json.loads(raw)
    data["chunks"] = [
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
    data["lastActivity"] = _now()
    await r.setex(f"batch:{user_id}:{batch_id}", BATCH_TTL, json.dumps(data))

    # Tag items with their chunk index for grouping in the UI
    for c in chunks:
        lo, hi = c["itemRange"]
        for i in range(lo, hi + 1):
            if 0 <= i < len(data["items"]):
                data["items"][i]["chunkIndex"] = c["index"]
    await r.setex(f"batch:{user_id}:{batch_id}", BATCH_TTL, json.dumps(data))


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
    r = await get_redis()
    raw = await r.get(f"batch:{user_id}:{batch_id}")
    if not raw:
        return
    data = json.loads(raw)
    chunks = data.get("chunks") or []
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
    data["lastActivity"] = _now()
    await r.setex(f"batch:{user_id}:{batch_id}", BATCH_TTL, json.dumps(data))


async def delete_batch(user_id: str, batch_id: str) -> None:
    r = await get_redis()
    await r.srem(f"user_batches:{user_id}", batch_id)
    await r.delete(f"batch:{user_id}:{batch_id}")


async def remove_batches_from_index(user_id: str, batch_ids) -> None:
    """Prune batch ids from the user's index without touching the batch data.

    Used when a batch's Redis key has expired but its id lingers in the
    user_batches set — those dangling ids would otherwise poison the list
    endpoint.
    """
    if not batch_ids:
        return
    r = await get_redis()
    await r.srem(f"user_batches:{user_id}", *batch_ids)
