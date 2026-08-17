"""
Durable user <-> admin messaging with read/unread tracking.

Powers the in-app message center and system-generated threads (e.g. the
auto-message sent when an admin rejects a receipt). Design notes:

- Conversations are strictly 1:1 pairs, normalized as (user_a < user_b),
  optionally threaded to a receipt (receipt_id) for contextual threads.
- Peer rule: at least one participant must be an admin -- non-admins can
  only message admins, admins can message any user. Enforced here AND by
  RLS on both tables (the app.current_user_id mechanism), so no tenant can
  read another's threads even with raw SQL.
- Delivery: every message is published to a Redis channel per recipient
  (messages:user:{uid}) for instant SSE delivery; the frontend keeps a 30s
  polling fallback. Publishing is best-effort -- losing a pub/sub event
  never loses the durable message.
"""
import json
import logging
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

from fastapi import HTTPException

from app.core.database import get_pool
from app.services import auth_service
from app.services.batch_service import get_redis

logger = logging.getLogger(__name__)

MAX_BODY_LENGTH = 4000
ALLOWED_KINDS = {"message", "system", "reject"}


def _ts(value) -> Optional[float]:
    if not value:
        return None
    return value.timestamp() if isinstance(value, datetime) else None


def _message_to_dict(row) -> Dict[str, Any]:
    payload = row["payload"]
    if isinstance(payload, str):
        try:
            payload = json.loads(payload) if payload else {}
        except json.JSONDecodeError:
            payload = {}
    return {
        "id": str(row["id"]),
        "conversation_id": str(row["conversation_id"]),
        "sender_id": row["sender_id"],
        "recipient_id": row["recipient_id"],
        "body": row["body"],
        "kind": row["kind"],
        "payload": payload or {},
        "read": row["read_at"] is not None,
        "created_at": _ts(row["created_at"]),
    }


async def _channel_for(user_id: str) -> str:
    return f"messages:user:{user_id}"


async def _publish(recipient_id: str, message: Dict[str, Any]) -> None:
    """Best-effort Redis pub/sub notify for instant SSE delivery."""
    try:
        redis = await get_redis()
        await redis.publish(
            await _channel_for(recipient_id),
            json.dumps(
                {
                    "conversation_id": message["conversation_id"],
                    "message_id": message["id"],
                    "kind": message["kind"],
                    "sender_id": message["sender_id"],
                },
                default=str,
            ),
        )
    except Exception:
        logger.warning("Failed to publish message event for user %s", recipient_id)


async def _ensure_conversation(
    uid: str, other_uid: str, receipt_id: Optional[str] = None
) -> tuple[str, str, str]:
    """Get-or-create the normalized 1:1 conversation for (uid, other)."""
    if other_uid == uid:
        raise HTTPException(status_code=400, detail="Cannot message yourself")
    a, b = sorted([uid, other_uid])
    rec = str(receipt_id) if receipt_id else None
    kind = "receipt" if rec else "pair"
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id FROM conversations
            WHERE user_a = $1 AND user_b = $2 AND receipt_id IS NOT DISTINCT FROM $3
            """,
            a, b, rec,
        )
        if row:
            return str(row["id"]), kind, rec
        conv_id = str(uuid.uuid4())
        try:
            await conn.execute(
                """
                INSERT INTO conversations (id, user_a, user_b, receipt_id, kind)
                VALUES ($1, $2, $3, $4, $5)
                """,
                conv_id, a, b, rec, kind,
            )
        except Exception:
            row = await conn.fetchrow(
                """
                SELECT id FROM conversations
                WHERE user_a = $1 AND user_b = $2 AND receipt_id IS NOT DISTINCT FROM $3
                """,
                a, b, rec,
            )
            if not row:
                raise
            conv_id = str(row["id"])
        return conv_id, kind, rec


async def _peer_rule_allowed(sender_uid: str, recipient_uid: str) -> None:
    """Users <-> Admins only: at least one side must be an admin."""
    sender = await auth_service.get_user_by_uid(sender_uid)
    recipient = await auth_service.get_user_by_uid(recipient_uid)
    if not sender or not recipient:
        raise HTTPException(status_code=404, detail="Sender or recipient not found")
    if not (sender["is_admin"] or recipient["is_admin"]):
        raise HTTPException(
            status_code=403,
            detail="Messages are only allowed between users and admins",
        )


async def send_message(
    uid: str,
    recipient_uid: str,
    body: str,
    *,
    kind: str = "message",
    payload: Optional[Dict[str, Any]] = None,
    receipt_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Send one message; creates the conversation if missing.
    `uid` is the authenticated sender; the workflow auto-message passes the
    acting admin's uid."""
    text = (body or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Message body cannot be empty")
    if len(text) > MAX_BODY_LENGTH:
        raise HTTPException(
            status_code=400, detail=f"Message exceeds {MAX_BODY_LENGTH} characters"
        )
    if kind not in ALLOWED_KINDS:
        raise HTTPException(status_code=400, detail=f"Unknown message kind: {kind}")

    await _peer_rule_allowed(uid, recipient_uid)
    conversation_id, _kind, _rec = await _ensure_conversation(
        uid, recipient_uid, receipt_id
    )

    message_id = str(uuid.uuid4())
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO messages (id, conversation_id, sender_id, recipient_id,
                                  body, kind, payload)
            VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
            """,
            message_id, conversation_id, uid, recipient_uid,
            text, kind, json.dumps(payload or {}, default=str),
        )
        await conn.execute(
            "UPDATE conversations SET last_message_at = now() WHERE id = $1",
            conversation_id,
        )
        row = await conn.fetchrow(
            """
            SELECT id, conversation_id, sender_id, recipient_id, body, kind,
                   payload, read_at, created_at
            FROM messages WHERE id = $1
            """,
            message_id,
        )
    message = _message_to_dict(row)
    await _publish(recipient_uid, message)
    return message


async def list_conversations(uid: str, limit: int = 100) -> List[Dict[str, Any]]:
    """All conversations the user participates in, newest first."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT c.id AS conv_id,
                   c.receipt_id,
                   c.kind,
                   c.last_message_at,
                   c.created_at,
                   CASE WHEN c.user_a = $1 THEN c.user_b ELSE c.user_a END AS other_uid,
                   (SELECT u.email FROM users u
                     WHERE u.uid = other_user.uid) AS other_email,
                   (SELECT u.display_name FROM users u
                     WHERE u.uid = other_user.uid) AS other_display_name,
                   (SELECT u.is_admin FROM users u
                     WHERE u.uid = other_user.uid) AS other_is_admin,
                   (SELECT m.body FROM messages m
                     WHERE m.conversation_id = c.id
                     ORDER BY m.created_at DESC LIMIT 1) AS last_body,
                   (SELECT m.sender_id FROM messages m
                     WHERE m.conversation_id = c.id
                     ORDER BY m.created_at DESC LIMIT 1) AS last_sender,
                   (SELECT count(*) FROM messages m
                     WHERE m.conversation_id = c.id
                       AND m.recipient_id = $1 AND m.read_at IS NULL) AS unread_count
            FROM conversations c
            CROSS JOIN LATERAL (
                SELECT CASE WHEN c.user_a = $1 THEN c.user_b ELSE c.user_a END AS uid
            ) AS other_user
            WHERE c.user_a = $1 OR c.user_b = $1
            ORDER BY c.last_message_at DESC
            LIMIT $2
            """,
            uid, limit,
        )
        return [
            {
                "id": str(r["conv_id"]),
                "receipt_id": str(r["receipt_id"]) if r["receipt_id"] else None,
                "kind": r["kind"],
                "last_message_at": _ts(r["last_message_at"]),
                "created_at": _ts(r["created_at"]),
                "other_user": {
                    "uid": r["other_uid"],
                    "email": r["other_email"],
                    "display_name": r["other_display_name"],
                    "is_admin": bool(r["other_is_admin"]),
                },
                "last_message": (
                    {
                        "body": r["last_body"],
                        "sender_id": r["last_sender"],
                    }
                    if r["last_body"] is not None
                    else None
                ),
                "unread_count": int(r["unread_count"] or 0),
            }
            for r in rows
        ]


def _require_uuid(value: str, what: str = "conversation_id") -> str:
    """Validate a UUID-formatted path/body param (prevents asyncpg casts of
    arbitrary strings from surfacing as 500s)."""
    try:
        uuid.UUID(str(value))
    except (ValueError, AttributeError):
        raise HTTPException(status_code=404, detail=f"{what} not found")
    return str(value)


async def list_messages(
    uid: str, conversation_id: str, before: Optional[float] = None, limit: int = 200
) -> List[Dict[str, Any]]:
    """Messages of a conversation the user participates in, oldest first."""
    conversation_id = _require_uuid(conversation_id)
    before_dt = None
    if before:
        from datetime import datetime, timezone

        before_dt = datetime.fromtimestamp(before, tz=timezone.utc)
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT m.id, m.conversation_id, m.sender_id, m.recipient_id,
                   m.body, m.kind, m.payload, m.read_at, m.created_at
            FROM messages m
            JOIN conversations c ON c.id = m.conversation_id
            WHERE m.conversation_id = $1
              AND (c.user_a = $2 OR c.user_b = $2)
              AND ($3::timestamptz IS NULL OR m.created_at < $3)
            ORDER BY m.created_at DESC
            LIMIT $4
            """,
            conversation_id, uid, before_dt, limit,
        )
    return [_message_to_dict(r) for r in reversed(rows)]


async def mark_read(uid: str, message_ids: List[str]) -> int:
    """Mark messages read -- only where the current user is the recipient."""
    if not message_ids:
        return 0
    cleaned: List[str] = []
    for mid in message_ids:
        try:
            uuid.UUID(str(mid))
        except (ValueError, AttributeError):
            continue
        cleaned.append(str(mid))
    message_ids = cleaned
    if not message_ids:
        return 0
    pool = await get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            UPDATE messages
            SET read_at = COALESCE(read_at, now())
            WHERE id = ANY($1::uuid[])
              AND recipient_id = $2
            """,
            message_ids, uid,
        )
    parts = result.split(" ")
    return int(parts[1]) if len(parts) == 2 else 0


async def mark_conversation_read(uid: str, conversation_id: str) -> int:
    """Mark every unread message in a conversation as read (recipient only)."""
    conversation_id = _require_uuid(conversation_id)
    pool = await get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            UPDATE messages
            SET read_at = COALESCE(read_at, now())
            WHERE conversation_id = $1 AND recipient_id = $2 AND read_at IS NULL
            """,
            conversation_id, uid,
        )
    parts = result.split(" ")
    return int(parts[1]) if len(parts) == 2 else 0


async def unread_count(uid: str) -> int:
    pool = await get_pool()
    async with pool.acquire() as conn:
        return int(
            await conn.fetchval(
                "SELECT count(*) FROM messages WHERE recipient_id = $1 AND read_at IS NULL",
                uid,
            )
            or 0
        )


async def peers(uid: str) -> List[Dict[str, Any]]:
    """Who can the current user message? Admins see all other users; regular
    users see all admins."""
    pool = await get_pool()
    async with pool.acquire() as conn:
        current = await conn.fetchrow(
            "SELECT is_admin FROM users WHERE uid = $1", uid
        )
        if not current:
            raise HTTPException(status_code=404, detail="User not found")
        if current["is_admin"]:
            rows = await conn.fetch(
                """
                SELECT uid, email, display_name FROM users
                WHERE uid <> $1 ORDER BY email
                """,
                uid,
            )
        else:
            rows = await conn.fetch(
                """
                SELECT uid, email, display_name FROM users
                WHERE is_admin = true AND uid <> $1 ORDER BY email
                """,
                uid,
            )
    peers_list = [
        {
            "uid": r["uid"],
            "email": r["email"],
            "display_name": r["display_name"],
            "is_admin": bool(current["is_admin"]),
        }
        for r in rows
    ]
    return peers_list
