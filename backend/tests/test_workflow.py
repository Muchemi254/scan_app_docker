"""
Tests for the controlled review → approval workflow.

Pipeline: needs_review → pending_approval → processed.

Rules verified here:
  - non-admin owner: submit (needs_review→pending), recall (pending→needs).
  - non-admin owner: CANNOT approve or mark processed (403).
  - admin: approve (pending→processed), reject (pending→needs, with note).
  - admin can impersonate another user's scope.
  - admin cross-tenant pending-approval list is admin-only.
  - status transitions are audited; rejections carry a note.
"""

import json

from tests.helpers import (
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    create_user_via_admin,
    login,
    sample_receipt,
)


def _create_payload(**overrides):
    data = sample_receipt()
    data.setdefault("status", "needs_review")
    data.update(overrides)
    return json.dumps(data)


async def _user(client, admin_headers, email, is_admin=False):
    return await create_user_via_admin(
        client, admin_headers, email, "pass-123", is_admin=is_admin
    )


async def _create(client, headers, uid, status="needs_review"):
    resp = await client.post(
        f"/api/v1/users/{uid}/receipts",
        headers=headers,
        files={"receipt_data": (None, _create_payload(status=status))},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _transition(client, headers, uid, rid, action, **json_body):
    resp = await client.post(
        f"/api/v1/users/{uid}/receipts/{rid}/{action}",
        headers=headers,
        json=json_body or None,
    )
    return resp


async def _audit(client, headers, uid, rid):
    resp = await client.get(
        f"/api/v1/users/{uid}/receipts/{rid}/audit", headers=headers
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["items"]


# ── Setup helpers ──────────────────────────────────────────────────────────

async def test_owner_submit_and_recall(client):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    alice = await _user(client, admin_headers, "alice@pytest.local")
    ah, _, _ = await login(client, "alice@pytest.local", "pass-123")
    uid = alice["uid"]

    rec = await _create(client, ah, uid)
    assert rec["status"] == "needs_review"

    # submit
    r = await _transition(client, ah, uid, rec["id"], "submit")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "pending_approval"

    # recall
    r = await _transition(client, ah, uid, rec["id"], "recall")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "needs_review"

    # audit trail records both transitions
    trail = await _audit(client, ah, uid, rec["id"])
    acts = [e["action"] for e in trail]
    assert "submitted" in acts
    assert "recalled" in acts


async def test_owner_cannot_approve_or_finalize(client):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    alice = await _user(client, admin_headers, "alice@pytest.local")
    ah, alice_user, _ = await login(client, "alice@pytest.local", "pass-123")
    uid = alice["uid"]

    # create directly as needs_review (alice CANNOT create as processed)
    r = await _create(client, ah, uid, status="needs_review")
    # creating as processed is blocked for non-admin
    resp = await client.post(
        f"/api/v1/users/{uid}/receipts",
        headers=ah,
        files={"receipt_data": (None, _create_payload(status="processed"))},
    )
    assert resp.status_code == 403, resp.text

    await _transition(client, ah, uid, r["id"], "submit")

    # non-admin cannot approve
    resp = await _transition(client, ah, uid, r["id"], "approve")
    assert resp.status_code in (403,), f"{resp.status_code}"

    # non-admin cannot mark processed via update
    resp = await client.put(
        f"/api/v1/users/{uid}/receipts/{r['id']}",
        headers=ah,
        files={"receipt_data": (None, json.dumps({"status": "processed"}))},
    )
    assert resp.status_code == 403, resp.text


async def test_admin_approve_and_reject_with_note(client):
    admin_headers, admin, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    alice = await _user(client, admin_headers, "alice@pytest.local")
    ah, _, _ = await login(client, "alice@pytest.local", "pass-123")
    uid = alice["uid"]

    rec = await _create(client, ah, uid)
    await _transition(client, ah, uid, rec["id"], "submit")

    # admin (in alice's scope via impersonation) approves
    r = await _transition(client, admin_headers, uid, rec["id"], "approve")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "processed"

    # new receipt → reject with note
    rec2 = await _create(client, ah, uid)
    await _transition(client, ah, uid, rec2["id"], "submit")
    r = await _transition(
        client, admin_headers, uid, rec2["id"], "reject", note="Duplicate of INV-1001"
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "needs_review"

    trail = await _audit(client, ah, uid, rec2["id"])
    rejected = [e for e in trail if e["action"] == "rejected"]
    assert rejected, trail
    assert rejected[0]["note"] == "Duplicate of INV-1001"


async def test_admin_cross_tenant_pending_list(client):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    alice = await _user(client, admin_headers, "alice@pytest.local")
    bob = await _user(client, admin_headers, "bob@pytest.local")
    ah, _, _ = await login(client, "alice@pytest.local", "pass-123")
    bh, _, _ = await login(client, "bob@pytest.local", "pass-123")

    await _transition(client, ah, alice["uid"], (await _create(client, ah, alice["uid"]))["id"], "submit")
    await _transition(client, bh, bob["uid"], (await _create(client, bh, bob["uid"]))["id"], "submit")

    # non-admin cannot list across tenants
    resp = await client.get("/api/v1/admin/receipts/pending-approval", headers=ah)
    assert resp.status_code == 403, resp.text

    # admin sees both owners' pending receipts with owner info
    resp = await client.get("/api/v1/admin/receipts/pending-approval", headers=admin_headers)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["total"] == 2
    uids = {i["owner_uid"] for i in data["items"]}
    assert uids == {alice["uid"], bob["uid"]}
