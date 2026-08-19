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


async def _create(client, headers, uid, status="needs_review", **overrides):
    resp = await client.post(
        f"/api/v1/users/{uid}/receipts",
        headers=headers,
        files={"receipt_data": (None, _create_payload(status=status, **overrides))},
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
    # every pending row carries its (possibly empty) location snapshot
    assert all("location" in i for i in data["items"])


async def test_non_admin_cannot_edit_or_delete_processed(client):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    alice = await _user(client, admin_headers, "alice@pytest.local")
    ah, _, _ = await login(client, "alice@pytest.local", "pass-123")
    uid = alice["uid"]

    rec = await _create(client, ah, uid)
    await _transition(client, ah, uid, rec["id"], "submit")
    r = await _transition(client, admin_headers, uid, rec["id"], "approve")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "processed"

    # owner cannot edit an approved (processed) receipt
    resp = await client.put(
        f"/api/v1/users/{uid}/receipts/{rec['id']}",
        headers=ah,
        files={"receipt_data": (None, json.dumps({"supplier": "Hacked"}))},
    )
    assert resp.status_code == 403, resp.text

    # owner cannot delete an approved (processed) receipt
    resp = await client.delete(
        f"/api/v1/users/{uid}/receipts/{rec['id']}", headers=ah
    )
    assert resp.status_code == 403, resp.text


async def test_double_approve_returns_conflict(client):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    alice = await _user(client, admin_headers, "alice@pytest.local")
    ah, _, _ = await login(client, "alice@pytest.local", "pass-123")
    uid = alice["uid"]

    rec = await _create(client, ah, uid)
    await _transition(client, ah, uid, rec["id"], "submit")

    r = await _transition(client, admin_headers, uid, rec["id"], "approve")
    assert r.status_code == 200, r.text

    # second approve on the now-processed receipt → guarded UPDATE misses → 409
    r2 = await _transition(client, admin_headers, uid, rec["id"], "approve")
    assert r2.status_code == 409, r2.text


# ── Rejected list (audit-derived, backs the user's Rejected tab) ────────────

async def test_rejected_list_shows_rejected_only(client):
    """GET /receipts?rejected=true returns only receipts whose most recent
    workflow decision was a rejection. Rejections revert the status to
    needs_review, so the filter is derived from the audit trail, not from
    the current status."""
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    alice = await _user(client, admin_headers, "alice@pytest.local")
    ah, _, _ = await login(client, "alice@pytest.local", "pass-123")
    uid = alice["uid"]

    # untouched receipt — never submitted, never rejected
    fresh = await _create(client, ah, uid)
    # rejected once
    rejected = await _create(client, ah, uid)
    await _transition(client, ah, uid, rejected["id"], "submit")
    r = await _transition(
        client, admin_headers, uid, rejected["id"], "reject", note="Fix the tax rate"
    )
    assert r.status_code == 200, r.text
    # approved
    processed = await _create(client, ah, uid)
    await _transition(client, ah, uid, processed["id"], "submit")
    r = await _transition(client, admin_headers, uid, processed["id"], "approve")
    assert r.status_code == 200, r.text

    resp = await client.get(
        f"/api/v1/users/{uid}/receipts?rejected=true", headers=ah
    )
    assert resp.status_code == 200, resp.text
    ids = {i["id"] for i in resp.json()["items"]}
    assert ids == {rejected["id"]}
    assert fresh["id"] not in ids
    assert processed["id"] not in ids

    # the plain list still shows the rejected receipt as needs_review
    resp = await client.get(
        f"/api/v1/users/{uid}/receipts?status=needs_review", headers=ah
    )
    assert resp.status_code == 200, resp.text
    by_id = {i["id"]: i for i in resp.json()["items"]}
    assert by_id[rejected["id"]]["status"] == "needs_review"
    assert fresh["id"] in by_id


async def test_rejected_after_resubmit_disappears(client):
    """Resubmitting a rejected receipt moves it off the rejected list — its
    latest workflow action is no longer a rejection."""
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    alice = await _user(client, admin_headers, "alice@pytest.local")
    ah, _, _ = await login(client, "alice@pytest.local", "pass-123")
    uid = alice["uid"]

    rec = await _create(client, ah, uid)
    await _transition(client, ah, uid, rec["id"], "submit")
    r = await _transition(
        client, admin_headers, uid, rec["id"], "reject", note="Fix the tax rate"
    )
    assert r.status_code == 200, r.text

    resp = await client.get(
        f"/api/v1/users/{uid}/receipts?rejected=true", headers=ah
    )
    assert {i["id"] for i in resp.json()["items"]} == {rec["id"]}

    await _transition(client, ah, uid, rec["id"], "submit")
    resp = await client.get(
        f"/api/v1/users/{uid}/receipts?rejected=true", headers=ah
    )
    assert {i["id"] for i in resp.json()["items"]} == set()


# ── Location required only for finalize-to-processed ─────────────────────────

async def test_submit_without_location_is_allowed(client):
    """No-location receipts may flow needs_review → pending_approval."""
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    alice = await _user(client, admin_headers, "alice@pytest.local")
    ah, _, _ = await login(client, "alice@pytest.local", "pass-123")
    uid = alice["uid"]

    rec = await _create(client, ah, uid, status="needs_review", location=None)
    assert rec["status"] == "needs_review"
    assert rec.get("location") is None

    r = await _transition(client, ah, uid, rec["id"], "submit")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "pending_approval"


async def test_approve_without_location_returns_422(client):
    """Admin cannot finalize a receipt to processed without a location."""
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    alice = await _user(client, admin_headers, "alice@pytest.local")
    ah, _, _ = await login(client, "alice@pytest.local", "pass-123")
    uid = alice["uid"]

    # reviewer did not fill a location
    resp = await client.post(
        f"/api/v1/users/{uid}/receipts",
        headers=ah,
        files={"receipt_data": (None, _create_payload(status="needs_review", location=None))},
    )
    assert resp.status_code == 201, resp.text
    rec = resp.json()

    await _transition(client, ah, uid, rec["id"], "submit")

    # approving without a location → 422
    r = await _transition(client, admin_headers, uid, rec["id"], "approve")
    assert r.status_code == 422, r.text

    # now the reviewer adds a location
    up = await client.put(
        f"/api/v1/users/{uid}/receipts/{rec['id']}",
        headers=ah,
        files={"receipt_data": (None, json.dumps({"location": "Nairobi HQ"}))},
    )
    assert up.status_code == 200, up.text

    # approving now succeeds
    r = await _transition(client, admin_headers, uid, rec["id"], "approve")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "processed"
    assert r.json()["location"] == "Nairobi HQ"


async def test_admin_cannot_finalize_without_location(client):
    """Admin create-as-processed and update-to-processed both need a location."""
    admin_headers, admin, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    alice = await _user(client, admin_headers, "alice@pytest.local")
    ah, _, _ = await login(client, "alice@pytest.local", "pass-123")
    uid = alice["uid"]

    # admin creates a processed receipt with a location → ok
    resp_ok = await client.post(
        f"/api/v1/users/{uid}/receipts",
        headers=admin_headers,
        files={"receipt_data": (None, _create_payload(status="processed", location="Nairobi HQ"))},
    )
    assert resp_ok.status_code == 201, resp_ok.text

    # admin create-as-processed without location → 422
    resp = await client.post(
        f"/api/v1/users/{uid}/receipts",
        headers=admin_headers,
        files={"receipt_data": (None, _create_payload(status="processed", location=None))},
    )
    assert resp.status_code == 422, resp.text

    # admin update-to-processed without location → 422
    rec = await _create(client, ah, uid, location=None)
    r = await client.put(
        f"/api/v1/users/{uid}/receipts/{rec['id']}",
        headers=admin_headers,
        files={"receipt_data": (None, json.dumps({"status": "processed"}))},
    )
    assert r.status_code == 422, r.text
