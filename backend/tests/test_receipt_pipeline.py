"""
Full integrated pipeline test — the user-facing receipt flow, end to end:

  bootstrap admin login
    → admin creates users (alice, bob)
    → users log in with local JWTs
    → alice configures AI settings
    → alice extracts receipt data (AI mocked)
    → alice saves the receipt (image + line items persisted)
    → list / get / update / search
    → backup export + direct download via ?token=
    → multi-tenant isolation between alice and bob
    → invalid/absent tokens rejected
"""

import json

from app.schemas.receipt import ReceiptCreate

from tests.helpers import (
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    create_user_via_admin,
    login,
    make_jpeg_bytes,
    sample_receipt,
)


async def test_full_authenticated_pipeline(client, monkeypatch):
    # ── 1. Auth bootstrap ──────────────────────────────────────────────
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)

    alice = await create_user_via_admin(client, admin_headers, "alice@pytest.local", "alice-pass")
    bob = await create_user_via_admin(client, admin_headers, "bob@pytest.local", "bob-pass")
    alice_uid = alice["uid"]
    bob_uid = bob["uid"]

    alice_headers, alice_user, alice_token = await login(client, "alice@pytest.local", "alice-pass")
    bob_headers, bob_user, bob_token = await login(client, "bob@pytest.local", "bob-pass")

    # ── 2. A protected route works with a local JWT ─────────────────────
    resp = await client.get(f"/api/v1/users/{alice_uid}/receipts", headers=alice_headers)
    assert resp.status_code == 200
    assert resp.json()["total"] == 0

    # ── 3. Save AI settings (protected route + Postgres settings store) ─
    resp = await client.put(
        f"/api/v1/users/{alice_uid}/settings/ai",
        headers=alice_headers,
        json={"provider": "gemini", "model_id": "gemini-3-flash-preview", "max_ai_concurrency": 2},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["provider"] == "gemini"

    # ── 4. Extract receipt data (AI provider mocked — offline) ──────────
    async def fake_extract(base64_data, mime_type, user_id):
        return ReceiptCreate.model_validate(sample_receipt())

    monkeypatch.setattr("app.api.receipts.extract_receipt_data", fake_extract)

    resp = await client.post(
        f"/api/v1/users/{alice_uid}/receipts/extract",
        headers=alice_headers,
        files={"file": ("receipt.jpg", make_jpeg_bytes(), "image/jpeg")},
    )
    assert resp.status_code == 200, resp.text
    extracted = resp.json()
    assert extracted["supplier"] == "ACME Grocery"
    assert len(extracted["items"]) == 2

    # ── 5. Save the receipt (multipart form + image) ────────────────────
    resp = await client.post(
        f"/api/v1/users/{alice_uid}/receipts",
        headers=alice_headers,
        files={
            "receipt_data": (None, json.dumps(extracted)),
            "file": ("receipt.jpg", make_jpeg_bytes(), "image/jpeg"),
        },
    )
    assert resp.status_code == 201, resp.text
    created = resp.json()
    receipt_id = created["id"]
    assert created["userId"] == alice_uid
    assert len(created["items"]) == 2

    # ── 6. List / get / search ──────────────────────────────────────────
    resp = await client.get(f"/api/v1/users/{alice_uid}/receipts", headers=alice_headers)
    assert resp.status_code == 200
    assert resp.json()["total"] == 1

    resp = await client.get(
        f"/api/v1/users/{alice_uid}/receipts/{receipt_id}", headers=alice_headers
    )
    assert resp.status_code == 200
    assert resp.json()["id"] == receipt_id

    resp = await client.get(
        f"/api/v1/users/{alice_uid}/receipts/search?q=ACME", headers=alice_headers
    )
    assert resp.status_code == 200
    assert resp.json()["total"] >= 1

    # ── 7. Update the receipt ───────────────────────────────────────────
    resp = await client.put(
        f"/api/v1/users/{alice_uid}/receipts/{receipt_id}",
        headers=alice_headers,
        files={"receipt_data": (None, json.dumps({"category": "Office"}))},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["category"] == "Office"

    # ── 8. Multi-tenant isolation ───────────────────────────────────────
    resp = await client.get(f"/api/v1/users/{alice_uid}/receipts", headers=bob_headers)
    assert resp.status_code == 403

    resp = await client.get(
        f"/api/v1/users/{alice_uid}/receipts/{receipt_id}", headers=bob_headers
    )
    assert resp.status_code == 403

    resp = await client.get(f"/api/v1/users/{bob_uid}/receipts", headers=bob_headers)
    assert resp.status_code == 200
    assert resp.json()["total"] == 0

    # ── 9. Invalid / absent tokens rejected ─────────────────────────────
    resp = await client.get(
        f"/api/v1/users/{alice_uid}/receipts",
        headers={"Authorization": "Bearer garbage.token.here"},
    )
    assert resp.status_code == 401

    resp = await client.get(f"/api/v1/users/{alice_uid}/receipts")
    assert resp.status_code in (401, 403)

    # ── 10. Backup export + direct download via ?token= ─────────────────
    resp = await client.post(f"/api/v1/users/{alice_uid}/backup/export", headers=alice_headers)
    assert resp.status_code == 200, resp.text
    assert len(resp.content) > 0

    listing = await client.get(f"/api/v1/users/{alice_uid}/backup/list", headers=alice_headers)
    assert listing.status_code == 200
    backups = listing.json()
    assert len(backups) == 1
    backup_id = backups[0]["id"]

    # Direct download: valid token in query string
    resp = await client.get(
        f"/api/v1/users/{alice_uid}/backup/download/{backup_id}?token={alice_token}",
        headers=alice_headers,
    )
    assert resp.status_code == 200
    assert len(resp.content) > 0

    # Bob's token must NOT download alice's backup
    resp = await client.get(
        f"/api/v1/users/{alice_uid}/backup/download/{backup_id}?token={bob_token}",
        headers=bob_headers,
    )
    assert resp.status_code in (401, 403)

    # Bogus token rejected
    resp = await client.get(
        f"/api/v1/users/{alice_uid}/backup/download/{backup_id}?token=garbage",
        headers=alice_headers,
    )
    assert resp.status_code == 401

    # ── 11. Deleted-user token invalidated end to end ───────────────────
    resp = await client.delete(f"/api/v1/auth/admin/users/{alice_user['uid']}", headers=admin_headers)
    assert resp.status_code == 204
    resp = await client.get(f"/api/v1/users/{alice_uid}/receipts", headers=alice_headers)
    assert resp.status_code == 401
