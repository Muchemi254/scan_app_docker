"""
Lightweight operation progress tracking (Redis-backed).

Used for long-running, server-side operations whose progress should survive a
browser refresh: backup imports and admin user deletions. State lives in Redis
(a ``op:{op_id}`` JSON key + a per-owner recent-index list) so it is cheap,
auto-expiring and readable from any page load — no DB table, no Celery.

All progress writes are fail-open: if Redis is unreachable the underlying
operation still proceeds, it just won't report progress.
"""

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_OP_KEY = "op:%s"
_IDX_KEY = "op:recent:%s"
_OP_TTL = 60 * 60 * 24       # 24h — completed ops stay viewable for a day
_IDX_TTL = 60 * 60 * 24
_MAX_RECENT = 50


async def _redis():
    from app.services.batch_service import get_redis
    return await get_redis()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_op_id() -> str:
    return str(uuid.uuid4())


async def start_op(op_id: str, op_type: str, owner: str,
                   total: Optional[Dict[str, int]] = None,
                   message: str = "Starting…") -> Optional[dict]:
    """Register a new running operation. Fail-open on Redis errors."""
    op = {
        "op_id": op_id,
        "op_type": op_type,
        "owner": owner,
        "status": "running",
        "stage": "starting",
        "message": message,
        "total": dict(total or {}),
        "counts": {},
        "errors": 0,
        "created_at": _now(),
        "updated_at": _now(),
        "completed_at": None,
        "result": None,
    }
    try:
        r = await _redis()
        await r.set(_OP_KEY % op_id, json.dumps(op), ex=_OP_TTL)
        await r.lpush(_IDX_KEY % owner, op_id)
        await r.expire(_IDX_KEY % owner, _IDX_TTL)
        await r.ltrim(_IDX_KEY % owner, 0, _MAX_RECENT - 1)
    except Exception as e:
        logger.warning("start_op(%s) Redis failure: %s", op_id, e)
    return op


async def update_op(op_id: str, *, stage: str = None, message: str = None,
                    counts: Dict[str, int] = None, errors: int = 0,
                    status: str = None, result: Any = None,
                    total: Dict[str, int] = None):
    """Patch a running/completed op. ``counts`` are *deltas*. Fail-open."""
    if not op_id:
        return None
    try:
        r = await _redis()
        key = _OP_KEY % op_id
        raw = await r.get(key)
        if not raw:
            return None
        op = json.loads(raw)
    except Exception as e:
        logger.warning("update_op(%s) Redis failure: %s", op_id, e)
        return None

    if stage is not None:
        op["stage"] = stage
    if message is not None:
        op["message"] = message
    if counts:
        for k, v in counts.items():
            op["counts"][k] = int(op["counts"].get(k, 0)) + int(v or 0)
    if errors:
        op["errors"] = int(op.get("errors", 0)) + int(errors)
    if total is not None:
        op["total"].update(total)
    op["updated_at"] = _now()
    if status is not None:
        op["status"] = status
    if result is not None:
        op["result"] = result
    if status in ("completed", "failed"):
        op["completed_at"] = _now()
    try:
        r = await _redis()
        await r.set(key, json.dumps(op), ex=_OP_TTL)
    except Exception as e:
        logger.warning("update_op(%s) Redis write failure: %s", op_id, e)
    return op


async def get_op(op_id: str) -> Optional[dict]:
    try:
        r = await _redis()
        raw = await r.get(_OP_KEY % op_id)
        return json.loads(raw) if raw else None
    except Exception as e:
        logger.warning("get_op(%s) Redis failure: %s", op_id, e)
        return None


async def list_ops(owner: str, op_type: Optional[str] = None,
                   limit: int = 20) -> List[dict]:
    """Recent ops for ``owner`` (kept newest-first)."""
    try:
        r = await _redis()
        ids = await r.lrange(_IDX_KEY % owner, 0, limit - 1)
        ops = []
        for oid in ids:
            op = await get_op(oid)
            if op and (op_type is None or op.get("op_type") == op_type):
                ops.append(op)
        return ops
    except Exception as e:
        logger.warning("list_ops(%s) Redis failure: %s", owner, e)
        return []