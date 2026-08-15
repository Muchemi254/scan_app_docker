"""
Integration tests for durable scan sessions — the prep → hold → dispatch flow.

Local prep ends in `prepared` holding state (no auto-dispatch to AI). The
user then sends groups/items/all explicitly via the dispatch endpoint. State
lives in Postgres, so held sessions survive and can be resumed later.

The dispatch Celery task is stubbed (`process_batch_task.delay` recorded) —
no broker, no real AI. AI extraction itself is covered by test_batch_pipeline.
"""

import pytest

from tests.helpers import (
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    create_user_via_admin,
    login,
    make_jpeg_bytes,
)


async def _make_user(client):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    user = await create_user_via_admin(client, admin_headers, "dave@pytest.local", "dave-pass")
    user_headers, _, _ = await login(client, "dave@pytest.local", "dave-pass")
    return user["uid"], user_headers


async def _create_and_prep(client, headers, user_id, title, n):
    """Create a batch and upload+prep n distinct images."""
    resp = await client.post(
        f"/api/v1/users/{user_id}/batches",
        json={"batchTitle": title, "filenames": [f"photo_{i}.jpg" for i in range(n)]},
        headers=headers,
    )
    assert resp.status_code == 201, resp.text
    batch_id = resp.json()["batchId"]

    files = [
        (
            "files",
            (
                f"photo_{i}.jpg",
                make_jpeg_bytes(width=120 + i, color=(150 + i, 180, 200)),
                "image/jpeg",
            ),
        )
        for i in range(n)
    ]
    resp = await client.post(
        f"/api/v1/users/{user_id}/batches/{batch_id}/process",
        files=files,
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    return batch_id, resp.json()


@pytest.mark.asyncio
async def test_prep_holds_and_groups(client):
    user_id, headers = await _make_user(client)
    batch_id, data = await _create_and_prep(client, headers, user_id, "Held scan", 55)

    # 55 images (> 50) → 2 groups; session ends PREPARED, nothing dispatched.
    assert data["status"] == "prepared"
    assert data["prepared"] == 55
    assert data["groups"] == 2
    assert data["duplicates"] == 0

    batch = (await client.get(f"/api/v1/users/{user_id}/batches/{batch_id}", headers=headers)).json()
    assert batch["status"] == "prepared"
    items = {i["index"]: i for i in batch["items"]}
    assert len(items) == 55
    for idx in range(0, 50):
        assert items[idx]["status"] == "prepared"
        assert items[idx]["groupIndex"] == 0
    for idx in range(50, 55):
        assert items[idx]["status"] == "prepared"
        assert items[idx]["groupIndex"] == 1

    await client.delete(f"/api/v1/users/{user_id}/batches/{batch_id}", headers=headers)


@pytest.mark.asyncio
async def test_prep_does_not_auto_dispatch(client, monkeypatch):
    user_id, headers = await _make_user(client)

    calls = []
    class Recorder:
        def delay(self, *args, **kwargs):
            calls.append((args, kwargs))
    monkeypatch.setattr("app.api.batches.process_batch_task", Recorder())

    await _create_and_prep(client, headers, user_id, "No auto dispatch", 10)

    # Prep alone must never enqueue the Celery AI task.
    assert calls == [], "prep dispatched to AI automatically — should hold instead"


@pytest.mark.asyncio
async def test_prep_never_dedups_prepared_images(client):
    """Prepared-but-unsent images are never dedup targets.

    Dedup links against the receipts table at AI-processing time only (covered by
    test_batch_pipeline). Holding the same bytes — twice in one session or again
    in a fresh session — must NOT mark items duplicate, so nothing the user
    prepped is ever silently dropped.
    """
    user_id, headers = await _make_user(client)
    twin = make_jpeg_bytes(width=321, color=(7, 9, 11))

    async def _prep_twins(title):
        resp = await client.post(
            f"/api/v1/users/{user_id}/batches",
            json={"batchTitle": title, "filenames": ["twin_a.jpg", "twin_b.jpg"]},
            headers=headers,
        )
        assert resp.status_code == 201, resp.text
        bid = resp.json()["batchId"]
        resp = await client.post(
            f"/api/v1/users/{user_id}/batches/{bid}/process",
            files=[
                ("files", ("twin_a.jpg", twin, "image/jpeg")),
                ("files", ("twin_b.jpg", twin, "image/jpeg")),
            ],
            headers=headers,
        )
        assert resp.status_code == 200, resp.text
        return bid, resp.json()

    bid1, data1 = await _prep_twins("Identical x2")
    assert data1["prepared"] == 2, "identical unsent images must both hold as prepared"
    assert data1["duplicates"] == 0

    # Fresh session, same bytes → still both held, linked to no receipt.
    bid2, data2 = await _prep_twins("Fresh x2")
    assert data2["prepared"] == 2
    assert data2["duplicates"] == 0
    assert data2["status"] == "prepared"

    await client.delete(f"/api/v1/users/{user_id}/batches/{bid1}", headers=headers)
    await client.delete(f"/api/v1/users/{user_id}/batches/{bid2}", headers=headers)


@pytest.mark.asyncio
async def test_dispatch_sends_only_requested_group(client, monkeypatch):
    user_id, headers = await _make_user(client)
    batch_id, data = await _create_and_prep(client, headers, user_id, "Dispatch", 55)
    assert data["prepared"] == 55

    calls = []
    class Recorder:
        def delay(self, *args, **kwargs):
            calls.append((args, kwargs))
    monkeypatch.setattr("app.api.batches.process_batch_task", Recorder())

    resp = await client.post(
        f"/api/v1/users/{user_id}/batches/{batch_id}/dispatch",
        json={"groups": [1]},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["dispatched"] == 5

    # Exactly the group-1 entries were enqueued (indices 50..54).
    assert len(calls) == 1
    entries = calls[0][0][3]
    assert sorted(e["index"] for e in entries) == list(range(50, 55))
    assert all(en["filename"] == f"{en['index']:04d}.jpg" for en in entries)
    assert all(e["sha256"] for e in entries)

    batch = (await client.get(f"/api/v1/users/{user_id}/batches/{batch_id}", headers=headers)).json()
    assert batch["status"] == "processing"
    items = {i["index"]: i for i in batch["items"]}
    for idx in range(50, 55):
        assert items[idx]["status"] == "pending", "dispatched items must be queued"
    for idx in range(0, 50):
        assert items[idx]["status"] == "prepared", "non-dispatched items must stay held"

    # Cannot dispatch while processing.
    resp = await client.post(
        f"/api/v1/users/{user_id}/batches/{batch_id}/dispatch",
        json={"all": True},
        headers=headers,
    )
    assert resp.status_code == 409

    await client.delete(f"/api/v1/users/{user_id}/batches/{batch_id}", headers=headers)


@pytest.mark.asyncio
async def test_dispatch_rejects_empty_or_prepared_done_sessions(client, monkeypatch):
    user_id, headers = await _make_user(client)
    batch_id, data = await _create_and_prep(client, headers, user_id, "Already done", 5)

    calls = []
    class Recorder:
        def delay(self, *args, **kwargs):
            calls.append((args, kwargs))
    monkeypatch.setattr("app.api.batches.process_batch_task", Recorder())

    # Dispatch all 5 → session moves to processing (worker stubbed, not run).
    resp = await client.post(
        f"/api/v1/users/{user_id}/batches/{batch_id}/dispatch",
        json={"all": True},
        headers=headers,
    )
    assert resp.status_code == 200
    assert resp.json()["dispatched"] == 5

    # Session now processing; dispatch rejected.
    resp = await client.post(
        f"/api/v1/users/{user_id}/batches/{batch_id}/dispatch",
        json={"groups": [0]},
        headers=headers,
    )
    assert resp.status_code == 409

    await client.delete(f"/api/v1/users/{user_id}/batches/{batch_id}", headers=headers)


@pytest.mark.asyncio
async def test_held_sessions_list_and_survive(client):
    """Prepared sessions are durable and listed — 'come back weeks later'."""
    user_id, headers = await _make_user(client)
    batch_id, _ = await _create_and_prep(client, headers, user_id, "Long-held", 3)

    listing = (await client.get(f"/api/v1/users/{user_id}/batches", headers=headers)).json()
    assert any(b["batchId"] == batch_id and b["status"] == "prepared" for b in listing)

    # A fresh read (simulating a later session / device) still sees it.
    again = (await client.get(f"/api/v1/users/{user_id}/batches/{batch_id}", headers=headers)).json()
    assert again["status"] == "prepared"
    assert sum(1 for i in again["items"] if i["status"] == "prepared") == 3

    await client.delete(f"/api/v1/users/{user_id}/batches/{batch_id}", headers=headers)


@pytest.mark.asyncio
async def test_group_completion_keeps_remaining_groups_dispatchable(client, monkeypatch):
    """
    Regression: dispatching one group and finishing it must NOT lock the rest.

    Session status is derived from item states — if held `prepared` items
    remain, the session stays `prepared` (dispatchable), never `done`.
    """
    user_id, headers = await _make_user(client)
    batch_id, data = await _create_and_prep(client, headers, user_id, "Partial", 55)
    assert data["prepared"] == 55

    from app.services import batch_service

    calls = []
    class Recorder:
        def delay(self, *args, **kwargs):
            calls.append((args, kwargs))
    monkeypatch.setattr("app.api.batches.process_batch_task", Recorder())

    # Dispatch group 1 (indices 50..54) only.
    resp = await client.post(
        f"/api/v1/users/{user_id}/batches/{batch_id}/dispatch",
        json={"groups": [1]},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["dispatched"] == 5

    # Simulate the worker: dispatches batch finishes → chunk done all items.
    await batch_service.set_batch_status(user_id, batch_id, "processing")
    for idx in range(50, 55):
        await batch_service.update_item(user_id, batch_id, idx, "done")
    b = await batch_service.get_batch(user_id, batch_id)
    assert batch_service.derive_session_status(b) == "prepared"

    # Stored status must reflect the derived one, and held group is dispatchable.
    batch = (await client.get(f"/api/v1/users/{user_id}/batches/{batch_id}", headers=headers)).json()
    assert batch["status"] == "prepared", "held items must keep session prepared"
    assert sum(1 for i in batch["items"] if i["status"] == "prepared") == 50

    resp = await client.post(
        f"/api/v1/users/{user_id}/batches/{batch_id}/dispatch",
        json={"groups": [0]},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["dispatched"] == 50

    await client.delete(f"/api/v1/users/{user_id}/batches/{batch_id}", headers=headers)


@pytest.mark.asyncio
async def test_session_done_only_when_all_items_dispatched(client, monkeypatch):
    """Once no prepared items remain, the session properly goes terminal."""
    user_id, headers = await _make_user(client)
    batch_id, _ = await _create_and_prep(client, headers, user_id, "Send all", 5)

    from app.services import batch_service

    calls = []
    class Recorder:
        def delay(self, *args, **kwargs):
            calls.append((args, kwargs))
    monkeypatch.setattr("app.api.batches.process_batch_task", Recorder())

    resp = await client.post(
        f"/api/v1/users/{user_id}/batches/{batch_id}/dispatch",
        json={"all": True},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text

    for idx in range(5):
        await batch_service.update_item(user_id, batch_id, idx, "done")
    batch = (await client.get(f"/api/v1/users/{user_id}/batches/{batch_id}", headers=headers)).json()
    assert batch["status"] == "done"
    assert sum(1 for i in batch["items"] if i["status"] == "prepared") == 0

    await client.delete(f"/api/v1/users/{user_id}/batches/{batch_id}", headers=headers)
