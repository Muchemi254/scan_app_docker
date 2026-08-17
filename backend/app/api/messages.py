"""
User <-> admin messaging endpoints.

- Conversations are strictly 1:1 (user <-> admin), optionally threaded to a
  receipt. Every operation is participant-scoped by RLS + explicit filters.
- GET /messages/stream is a Server-Sent Events endpoint fed by Redis
  pub/sub (channel messages:user:{uid}) so an open chat page updates
  instantly; the badge poll every 30s is the fallback.
- The SSE stream accepts ?token= (the same JWT used for the Authorization
  header) because EventSource cannot set headers.
"""
import asyncio
import json
import logging
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

from app.api.auth import get_current_user_id
from app.core.database import set_current_user_id
from app.services import messages_service
from app.services.batch_service import get_redis

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/messages", tags=["messages"])

_SSE_HEARTBEAT_SECONDS = 15


def _sse(data: dict) -> str:
    return f"data: {json.dumps(data, default=str)}\n\n"


def _sse_comment() -> str:
    return ": keep-alive\n\n"


@router.get("/stream")
async def stream_messages(
    request: Request,
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(
        HTTPBearer(auto_error=False)
    ),
    token: Optional[str] = Query(None, description="JWT fallback for EventSource"),
):
    """SSE: push an event for every new message addressed to this user.

    EventSource cannot set Authorization headers, so the same JWT is also
    accepted via ?token=. The connection is authenticated here (before the
    stream starts) so invalid/expired tokens reply 401 instead of opening
    a stream.
    """
    from app.core.security import _verify_token

    raw_token = credentials.credentials if credentials else token
    if not raw_token:
        raise HTTPException(status_code=401, detail="Authentication required")
    user_id = await _verify_token(raw_token)
    set_current_user_id(user_id)

    async def event_generator():
        redis = await get_redis()
        pubsub = redis.pubsub()
        channel = await messages_service._channel_for(user_id)
        await pubsub.subscribe(channel)
        try:
            yield _sse({"type": "connected", "user_id": user_id})
            while True:
                try:
                    message = await pubsub.get_message(
                        ignore_subscribe_messages=True, timeout=_SSE_HEARTBEAT_SECONDS
                    )
                except asyncio.TimeoutError:
                    message = None
                except Exception:
                    logger.exception("SSE pubsub error for user %s", user_id)
                    await asyncio.sleep(1)
                    continue
                if message and message.get("type") == "message":
                    try:
                        data = json.loads(message["data"])
                        yield _sse({"type": "message", "data": data})
                    except (json.JSONDecodeError, KeyError):
                        logger.warning("Bad SSE payload for user %s", user_id)
                else:
                    yield _sse_comment()
        finally:
            try:
                await pubsub.unsubscribe(channel)
            except Exception:
                pass

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/conversations")
async def list_conversations(
    user_id: str = Depends(get_current_user_id),
):
    return await messages_service.list_conversations(user_id)


@router.get("/conversations/{conversation_id}/messages")
async def list_messages(
    conversation_id: str,
    before: Optional[float] = Query(None, description="Unix timestamp cursor"),
    user_id: str = Depends(get_current_user_id),
):
    return await messages_service.list_messages(user_id, conversation_id, before=before)


@router.post("/conversations/{conversation_id}/read")
async def mark_conversation_read(
    conversation_id: str,
    user_id: str = Depends(get_current_user_id),
):
    count = await messages_service.mark_conversation_read(user_id, conversation_id)
    return {"marked": count}


@router.post("/read")
async def mark_read(
    body: dict,
    user_id: str = Depends(get_current_user_id),
):
    ids = body.get("message_ids") or []
    if not isinstance(ids, list):
        raise HTTPException(status_code=400, detail="message_ids must be a list")
    count = await messages_service.mark_read(user_id, [str(i) for i in ids])
    return {"marked": count}


@router.get("/unread-count")
async def unread_count(
    user_id: str = Depends(get_current_user_id),
):
    return {"unread": await messages_service.unread_count(user_id)}


@router.get("/peers")
async def list_peers(
    user_id: str = Depends(get_current_user_id),
):
    """Who the current user can start a conversation with."""
    return {"peers": await messages_service.peers(user_id)}


@router.get("/templates")
async def list_templates(
    _user_id: str = Depends(get_current_user_id),
):
    """The predefined receipt message templates for the compose box.

    The catalog is server-side: sending with template_key renders the body
    canonically from these templates (never from client-supplied text).
    """
    from app.services.message_templates import list_templates

    return {"templates": list_templates()}


class _SendRequest(BaseModel):
    recipient_uid: str
    body: str = ""
    receipt_id: Optional[str] = None
    template_key: Optional[str] = None
    variables: Optional[dict] = None


@router.post("/send")
async def send_message(
    req: _SendRequest,
    user_id: str = Depends(get_current_user_id),
):
    """Send a message or send one of the predefined receipt templates.

    With `template_key` set, `body`/`kind` are ignored and the message is
    rendered server-side from the template + `variables` (single source of
    truth; the bubble payload is built from the same variables).
    """
    kind: Optional[str] = None
    payload: Optional[dict] = None
    receipt_id: Optional[str] = None
    if req.template_key:
        from app.services.message_templates import render_template

        variables = dict(req.variables or {})
        # Receipt-context templates should render with the system receipt_id
        # variable and land in the pair's receipt thread when one exists.
        if not variables.get("receipt_id"):
            receipt_conv = await messages_service.find_receipt_conversation(
                user_id, req.recipient_uid
            )
            if receipt_conv and receipt_conv.get("receipt_id"):
                receipt_id = str(receipt_conv["receipt_id"])
                variables["receipt_id"] = receipt_id[:8]
        try:
            kind, body, payload = render_template(req.template_key, variables)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
    else:
        body = req.body
        receipt_id = req.receipt_id

    message = await messages_service.send_message(
        user_id,
        req.recipient_uid,
        body,
        kind=kind,
        payload=payload,
        receipt_id=receipt_id,
    )
    return message
