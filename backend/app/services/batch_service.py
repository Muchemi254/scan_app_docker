"""
Batch scanning service.

Manages batch state in Redis so that:
 - Processing runs entirely on the backend (survives frontend refresh/navigation)
 - Frontend can reconnect to an in-progress batch by batchId
 - State is visible across devices logged in as the same user

Redis schema (key = batch:{batchId}):
  {
    "batchId": str,
    "userId": str,
    "batchTitle": str,
    "status": "uploading" | "processing" | "done" | "failed",
    "createdAt": float,
    "items": [
      {
        "index": int,
        "filename": str,
        "status": "pending" | "processing" | "done" | "needs_review" | "failed",
        "receiptId": str | null,
        "message": str | null
      }
    ]
  }

In-memory image store (dict keyed by batchId):
  Holds raw image bytes while background task is running.
  Cleared when processing finishes.
  Lost on server restart — handled by detecting missing images and marking batch failed.
"""

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

_redis: Optional[aioredis.Redis] = None


async def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        _redis = aioredis.from_url(settings.REDIS_URL, decode_responses=True)
    return _redis


async def close_redis() -> None:
    global _redis
    if _redis:
        await _redis.aclose()
        _redis = None


# ─── In-memory image store ───────────────────────────────────────────────────

# batchId → [(filename, image_bytes, content_type), ...]
_batch_images: Dict[str, List[Tuple[str, bytes, str]]] = {}


def store_images(batch_id: str, images: List[Tuple[str, bytes, str]]) -> None:
    _batch_images[batch_id] = images


def get_images(batch_id: str) -> Optional[List[Tuple[str, bytes, str]]]:
    return _batch_images.get(batch_id)


def clear_images(batch_id: str) -> None:
    _batch_images.pop(batch_id, None)


def has_images(batch_id: str) -> bool:
    return batch_id in _batch_images


# ─── Batch CRUD ─────────────────────────────────────────────────────────────


async def create_batch(user_id: str, batch_title: str, filenames: List[str]) -> str:
    r = await get_redis()
    batch_id = str(uuid.uuid4())
    data = {
        "batchId": batch_id,
        "userId": user_id,
        "batchTitle": batch_title,
        "status": "uploading",
        "createdAt": datetime.now(timezone.utc).timestamp(),
        "items": [
            {
                "index": i,
                "filename": fn,
                "status": "pending",
                "receiptId": None,
                "message": None,
            }
            for i, fn in enumerate(filenames)
        ],
    }
    # Save batch data
    await r.setex(f"batch:{batch_id}", BATCH_TTL, json.dumps(data))
    # Add to user's active batches index
    await r.sadd(f"user_batches:{user_id}", batch_id)
    return batch_id


async def get_user_batches(user_id: str) -> List[str]:
    """Get all batch IDs for a user."""
    r = await get_redis()
    return await r.smembers(f"user_batches:{user_id}")


async def get_batch(batch_id: str) -> Optional[dict]:
    r = await get_redis()
    raw = await r.get(f"batch:{batch_id}")
    if not raw:
        return None
    return json.loads(raw)


async def set_batch_status(batch_id: str, status: str) -> None:
    r = await get_redis()
    raw = await r.get(f"batch:{batch_id}")
    if not raw:
        return
    data = json.loads(raw)
    data["status"] = status
    await r.setex(f"batch:{batch_id}", BATCH_TTL, json.dumps(data))


async def update_item(
    batch_id: str,
    index: int,
    status: str,
    receipt_id: Optional[str] = None,
    message: Optional[str] = None,
) -> None:
    r = await get_redis()
    raw = await r.get(f"batch:{batch_id}")
    if not raw:
        return
    data = json.loads(raw)
    item = data["items"][index]
    item["status"] = status
    if receipt_id is not None:
        item["receiptId"] = receipt_id
    if message is not None:
        item["message"] = message
    await r.setex(f"batch:{batch_id}", BATCH_TTL, json.dumps(data))


async def delete_batch(batch_id: str) -> None:
    r = await get_redis()
    raw = await r.get(f"batch:{batch_id}")
    if raw:
        data = json.loads(raw)
        user_id = data.get("userId")
        if user_id:
            await r.srem(f"user_batches:{user_id}", batch_id)
            
    await r.delete(f"batch:{batch_id}")
    clear_images(batch_id)
