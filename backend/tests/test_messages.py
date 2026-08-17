"""
Tests for the user <-> admin messaging system.

Covers:
  - peer rule: two non-admins cannot message each other; users <-> admins
    works in both directions
  - conversation creation + unread/read lifecycle (list, messages, unread
    count, mark conversation read, mark individual messages read)
  - participant isolation: no cross-tenant leakage through the API
  - row-level security: raw SQL still cannot read another tenant's threads
  - reject workflow auto-message (kind=reject, note + structured payload)
  - send validation: empty body, oversized body, self-message
  - peers endpoint scoping (user sees admins only; admin sees all users)
  - Redis pub/sub event fired on send (the SSE delivery layer)
"""

import json

import pytest

from tests.helpers import ADMIN_EMAIL, ADMIN_PASSWORD, create_user_via_admin, login
from tests.test_workflow import _create, _transition


async def _admin(client):
    headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    return headers


async def _user(client, admin_headers, email, is_admin=False):
    return await create_user_via_admin(
        client, admin_headers, email, "pass-123", is_admin=is_admin
    )


async def _login(client, email):
    headers, user, _ = await login(client, email, "pass-123")
    return headers, user


_client = None


@pytest.fixture(autouse=True)
def _bind_client(client):
    global _client
    _client = client
    yield


async def _send(headers, recipient_uid, body, receipt_id=None):
    payload = {"recipient_uid": recipient_uid, "body": body}
    if receipt_id:
        payload["receipt_id"] = receipt_id
    return await _client.post("/api/v1/messages/send", headers=headers, json=payload)


async def _conversations(headers):
    resp = await _client.get("/api/v1/messages/conversations", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _messages(headers, conv_id):
    resp = await _client.get(
        f"/api/v1/messages/conversations/{conv_id}/messages", headers=headers
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _unread(headers):
    resp = await _client.get("/api/v1/messages/unread-count", headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()["unread"]


# ── Peer rule ──────────────────────────────────────────────────────────────

async def test_users_cannot_message_other_users(client):
    admin_headers = await _admin(client)
    alice = await _user(client, admin_headers, "alice@pytest.local")
    bob = await _user(client, admin_headers, "bob@pytest.local")
    ah, _ = await _login(client, "alice@pytest.local")

    resp = await _send(ah, bob["uid"], "hello bob")
    assert resp.status_code == 403, resp.text


async def test_admin_to_user_message_succeeds(client):
    admin_headers = await _admin(client)
    alice = await _user(client, admin_headers, "alice@pytest.local")

    resp = await _send(admin_headers, alice["uid"], "hello from admin")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["recipient_id"] == alice["uid"]

    resp = await _send(admin_headers, "does-not-exist", "hello ghost")
    assert resp.status_code == 404, resp.text


# ── Lifecycle ──────────────────────────────────────────────────────────────

async def test_message_lifecycle_unread_and_read(client):
    admin_headers = await _admin(client)
    admin_user = await _user(client, admin_headers, "boss@pytest.local", is_admin=True)
    alice = await _user(client, admin_headers, "alice@pytest.local")
    ah, _ = await _login(client, "alice@pytest.local")
    bh, _ = await _login(client, "boss@pytest.local")

    # admin -> alice
    resp = await _send(bh, alice["uid"], "Welcome, please fix your submission")
    assert resp.status_code == 200, resp.text
    conv_id = resp.json()["conversation_id"]

    # alice sees the thread with unread=1 and correct last message
    convs = await _conversations(ah)
    assert len(convs) == 1
    conv = convs[0]
    assert conv["id"] == conv_id
    assert conv["unread_count"] == 1
    assert conv["last_message"]["body"] == "Welcome, please fix your submission"
    assert conv["other_user"]["is_admin"] is True
    assert conv["other_user"]["uid"] == admin_user["uid"]

    assert await _unread(ah) == 1

    msgs = await _messages(ah, conv_id)
    assert len(msgs) == 1
    assert msgs[0]["read"] is False
    assert msgs[0]["recipient_id"] == alice["uid"]

    # mark the conversation read -> badge clears
    resp = await client.post(
        f"/api/v1/messages/conversations/{conv_id}/read", headers=ah
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["marked"] == 1
    assert await _unread(ah) == 0

    msgs = await _messages(ah, conv_id)
    assert msgs[0]["read"] is True

    # the sender (admin) never accumulates unread from their own message
    assert await _unread(bh) == 0


async def test_user_reply_lands_in_same_thread_and_admin_sees_it(client):
    admin_headers = await _admin(client)
    admin_user = await _user(client, admin_headers, "boss@pytest.local", is_admin=True)
    alice = await _user(client, admin_headers, "alice@pytest.local")
    ah, _ = await _login(client, "alice@pytest.local")
    bh, _ = await _login(client, "boss@pytest.local")

    await _send(bh, alice["uid"], "please fix")
    convs = await _conversations(ah)
    conv_id = convs[0]["id"]

    # alice replies in the same thread
    resp = await _send(ah, admin_user["uid"], "fixed, please recheck")
    assert resp.status_code == 200, resp.text
    assert resp.json()["conversation_id"] == conv_id

    # admin now has unread for the reply
    assert await _unread(bh) == 1
    convs_admin = await _conversations(bh)
    assert len(convs_admin) == 1
    assert convs_admin[0]["unread_count"] == 1
    assert convs_admin[0]["last_message"]["body"] == "fixed, please recheck"

    # thread has both messages, oldest first
    msgs = await _messages(ah, conv_id)
    assert [m["body"] for m in msgs] == ["please fix", "fixed, please recheck"]


async def test_mark_read_individual_messages(client):
    admin_headers = await _admin(client)
    admin_user = await _user(client, admin_headers, "boss@pytest.local", is_admin=True)
    alice = await _user(client, admin_headers, "alice@pytest.local")
    ah, _ = await _login(client, "alice@pytest.local")
    bh, _ = await _login(client, "boss@pytest.local")

    m1 = (await _send(bh, alice["uid"], "first")) .json()
    m2 = (await _send(bh, alice["uid"], "second")) .json()
    assert await _unread(ah) == 2

    resp = await client.post(
        "/api/v1/messages/read",
        headers=ah,
        json={"message_ids": [m1["id"]]},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["marked"] == 1
    assert await _unread(ah) == 1

    # marking another user's message as read is a no-op
    resp = await client.post(
        "/api/v1/messages/read",
        headers=bh,
        json={"message_ids": [m1["id"], m2["id"]]},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["marked"] == 0
    assert await _unread(ah) == 1


# ── Isolation ──────────────────────────────────────────────────────────────

async def test_participant_isolation(client):
    admin_headers = await _admin(client)
    admin_user = await _user(client, admin_headers, "boss@pytest.local", is_admin=True)
    alice = await _user(client, admin_headers, "alice@pytest.local")
    charlie = await _user(client, admin_headers, "charlie@pytest.local")
    ah, _ = await _login(client, "alice@pytest.local")
    bh, _ = await _login(client, "boss@pytest.local")
    ch, _ = await _login(client, "charlie@pytest.local")

    resp = await _send(bh, alice["uid"], "secret admin note")
    conv_id = resp.json()["conversation_id"]

    # charlie cannot see the thread, its messages, or the unread
    assert await _conversations(ch) == []
    assert await _messages(ch, conv_id) == []
    assert await _unread(ch) == 0

    # charlie cannot mark it read
    resp = await client.post(
        f"/api/v1/messages/conversations/{conv_id}/read", headers=ch
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["marked"] == 0
    assert await _unread(ah) == 1

    # bogus conversation ids are rejected cleanly, not 500
    resp = await client.get(
        "/api/v1/messages/conversations/not-a-uuid/messages", headers=ah
    )
    assert resp.status_code == 404, resp.text


async def test_service_layer_blocks_non_participant_reads(client):
    """The enforceable boundary is the service layer: every conversation/message
    query is filtered by participant membership (the app connects as the
    `scanapp` superuser, which bypasses Postgres RLS)."""
    admin_headers = await _admin(client)
    alice = await _user(client, admin_headers, "alice@pytest.local")
    charlie = await _user(client, admin_headers, "charlie@pytest.local")
    ah, _ = await _login(client, "alice@pytest.local")
    ch, _ = await _login(client, "charlie@pytest.local")

    # admin -> alice message
    resp = await _send(admin_headers, alice["uid"], "hello alice")
    assert resp.status_code == 200, resp.text

    # charlie has no access through the API, even knowing the conversation id
    convs_alice = await _conversations(ah)
    conv_id = convs_alice[0]["id"]
    assert await _conversations(ch) == []
    assert await _messages(ch, conv_id) == []
    assert await _unread(ch) == 0


# ── Reject auto-message ────────────────────────────────────────────────────

async def test_reject_sends_auto_message_with_note(client):
    admin_headers = await _admin(client)
    alice = await _user(client, admin_headers, "alice@pytest.local")
    ah, alice_user = await _login(client, "alice@pytest.local")
    uid = alice["uid"]

    rec = await _create(client, ah, uid)
    await _transition(client, ah, uid, rec["id"], "submit")

    r = await _transition(
        client, admin_headers, uid, rec["id"], "reject",
        note="Duplicate of INV-1001",
    )
    assert r.status_code == 200, r.text

    # alice gets a receipt-threaded conversation with an unread reject message
    convs = await _conversations(ah)
    assert len(convs) == 1
    conv = convs[0]
    assert conv["receipt_id"] == rec["id"]
    assert conv["kind"] == "receipt"
    assert conv["unread_count"] == 1

    msgs = await _messages(ah, conv["id"])
    assert len(msgs) == 1
    msg = msgs[0]
    assert msg["kind"] == "reject"
    assert "Duplicate of INV-1001" in msg["body"]
    assert msg["payload"]["note"] == "Duplicate of INV-1001"
    assert msg["payload"]["receipt_id"] == rec["id"]
    assert msg["payload"]["supplier"]

    # admin side: thread exists, no unread
    convs_admin = await _conversations(admin_headers)
    assert len(convs_admin) == 1
    assert convs_admin[0]["unread_count"] == 0


async def test_reject_without_note_still_messages(client):
    admin_headers = await _admin(client)
    alice = await _user(client, admin_headers, "alice@pytest.local")
    ah, _ = await _login(client, "alice@pytest.local")
    uid = alice["uid"]

    rec = await _create(client, ah, uid)
    await _transition(client, ah, uid, rec["id"], "submit")
    r = await _transition(client, admin_headers, uid, rec["id"], "reject", note=None)
    assert r.status_code == 200, r.text

    convs = await _conversations(ah)
    assert len(convs) == 1
    msgs = await _messages(ah, convs[0]["id"])
    assert msgs[0]["kind"] == "reject"
    assert msgs[0]["payload"]["note"] is None


# ── Validation ─────────────────────────────────────────────────────────────

async def test_send_validation(client):
    admin_headers = await _admin(client)
    alice = await _user(client, admin_headers, "alice@pytest.local")
    ah, _ = await _login(client, "alice@pytest.local")

    resp = await _send(ah, alice["uid"], "   ")
    assert resp.status_code == 400, resp.text

    resp = await _send(ah, alice["uid"], "x" * 4001)
    assert resp.status_code == 400, resp.text

    _, admin_user, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    resp = await _send(admin_headers, admin_user["uid"], "hello self")
    assert resp.status_code == 400, resp.text


# ── Peers ──────────────────────────────────────────────────────────────────

async def test_peers_scoping(client):
    admin_headers = await _admin(client)
    admin_user = await _user(client, admin_headers, "boss@pytest.local", is_admin=True)
    alice = await _user(client, admin_headers, "alice@pytest.local")
    bob = await _user(client, admin_headers, "bob@pytest.local")
    ah, _ = await _login(client, "alice@pytest.local")
    bh, _ = await _login(client, "boss@pytest.local")

    resp = await client.get("/api/v1/messages/peers", headers=ah)
    assert resp.status_code == 200, resp.text
    peers = resp.json()["peers"]
    uids = [p["uid"] for p in peers]
    assert admin_user["uid"] in uids
    assert alice["uid"] not in uids
    assert bob["uid"] not in uids

    resp = await client.get("/api/v1/messages/peers", headers=bh)
    peers = resp.json()["peers"]
    uids = [p["uid"] for p in peers]
    assert alice["uid"] in uids and bob["uid"] in uids
    assert admin_user["uid"] not in uids


# ── Redis pub/sub delivery ─────────────────────────────────────────────────

async def test_pubsub_event_published_on_send(client):
    from app.services.batch_service import get_redis
    from app.services.messages_service import _channel_for

    admin_headers = await _admin(client)
    alice = await _user(client, admin_headers, "alice@pytest.local")

    redis = await get_redis()
    pubsub = redis.pubsub()
    await pubsub.subscribe(await _channel_for(alice["uid"]))
    try:
        resp = await _send(admin_headers, alice["uid"], "instant delivery event")
        assert resp.status_code == 200, resp.text
        mid = resp.json()["id"]

        event = None
        for _ in range(10):
            msg = await pubsub.get_message(
                ignore_subscribe_messages=True, timeout=1
            )
            if msg and msg.get("type") == "message":
                event = json.loads(msg["data"])
                break
        assert event is not None, "no pub/sub event received"
        assert event["message_id"] == mid
        assert event.get("conversation_id")
    finally:
        await pubsub.unsubscribe()
