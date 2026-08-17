"""
Tests for the AI summary master switch:

  - disabled by default (no LLM tokens spent until an admin opts in)
  - admin-only toggle via GET/PUT /settings/global/ai-summary
  - dashboard insights and the receipts summary endpoint skip the LLM
    call entirely while disabled
"""

import json
from unittest.mock import AsyncMock

from tests.helpers import (
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    create_user_via_admin,
    login,
    sample_receipt,
)


async def _non_admin(client, admin_headers, email="sumuser@pytest.local"):
    user = await create_user_via_admin(client, admin_headers, email, "pass-123")
    ah, _, _ = await login(client, email, "pass-123")
    return user["uid"], ah


async def _seed_receipts(client, headers, uid, count=3):
    for i in range(count):
        data = sample_receipt(invoice=f"SUM-INV-{i}")
        data["status"] = "needs_review"
        resp = await client.post(
            f"/api/v1/users/{uid}/receipts",
            headers=headers,
            files={"receipt_data": (None, json.dumps(data))},
        )
        assert resp.status_code == 201, resp.text


async def _enable_summary(client, admin_headers, enabled=True):
    resp = await client.put(
        "/api/v1/settings/global/ai-summary",
        headers=admin_headers,
        json={"enabled": enabled},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_ai_summary_disabled_by_default(client):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    resp = await client.get("/api/v1/settings/global/ai-summary", headers=admin_headers)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"enabled": False}


async def test_ai_summary_toggle_is_admin_only(client):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    uid, ah = await _non_admin(client, admin_headers)

    # non-admin cannot change the global switch
    resp = await client.put(
        "/api/v1/settings/global/ai-summary", headers=ah, json={"enabled": True}
    )
    assert resp.status_code == 403, resp.text

    # admin can toggle on … and back off; the value persists
    assert (await _enable_summary(client, admin_headers, True)) == {"enabled": True}
    resp = await client.get("/api/v1/settings/global/ai-summary", headers=admin_headers)
    assert resp.json() == {"enabled": True}
    assert (await _enable_summary(client, admin_headers, False)) == {"enabled": False}


async def test_dashboard_insights_skip_llm_when_disabled(client, monkeypatch):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    uid, ah = await _non_admin(client, admin_headers)
    await _seed_receipts(client, ah, uid)

    fake = AsyncMock(return_value="This should never be called")
    monkeypatch.setattr("app.services.dashboard_service.generate_ai_summary", fake)

    resp = await client.get(f"/api/v1/users/{uid}/dashboard/insights", headers=ah)
    assert resp.status_code == 200, resp.text
    assert resp.json()["ai_summary"] is None
    fake.assert_not_awaited()


async def test_dashboard_insights_call_llm_when_enabled(client, monkeypatch):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    uid, ah = await _non_admin(client, admin_headers)
    await _seed_receipts(client, ah, uid)

    fake = AsyncMock(return_value="AI: you spent a lot.")
    monkeypatch.setattr("app.services.dashboard_service.generate_ai_summary", fake)
    await _enable_summary(client, admin_headers, True)

    resp = await client.get(f"/api/v1/users/{uid}/dashboard/insights", headers=ah)
    assert resp.status_code == 200, resp.text
    assert resp.json()["ai_summary"] == "AI: you spent a lot."
    fake.assert_awaited_once()


async def test_receipts_summary_endpoint_gated(client, monkeypatch):
    admin_headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    uid, ah = await _non_admin(client, admin_headers)
    await _seed_receipts(client, ah, uid)

    fake = AsyncMock(return_value="FAKE_AI_SUMMARY")
    monkeypatch.setattr("app.api.receipts.generate_ai_summary", fake)

    # disabled → aggregate response without AI narrative, LLM untouched
    resp = await client.post(
        f"/api/v1/users/{uid}/receipts/summary", headers=ah, json={}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["total_receipts"] == 3
    assert body["ai_summary"] is None
    fake.assert_not_awaited()

    # enabled → AI narrative produced
    await _enable_summary(client, admin_headers, True)
    resp = await client.post(
        f"/api/v1/users/{uid}/receipts/summary", headers=ah, json={}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["ai_summary"] == "FAKE_AI_SUMMARY"
    fake.assert_awaited_once()