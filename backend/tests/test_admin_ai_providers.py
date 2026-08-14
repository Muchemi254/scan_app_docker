"""
Tests for admin-managed shared AI provider keys.

  GET  /api/v1/auth/admin/settings/ai-providers   (admin only, masked)
  PUT  /api/v1/auth/admin/settings/ai-providers   (admin only)

Covers masking, persistence/encryption, masked-key-preserve semantics,
admin authorization, and key-resolution (user key > admin key > error).
"""

from app.core.encryption import encrypt_api_key
from app.services import admin_keys_service
from app.services.database_service import DatabaseService
from tests.helpers import ADMIN_EMAIL, ADMIN_PASSWORD, create_user_via_admin, login


async def _admin_headers(client):
    headers, _, _ = await login(client, ADMIN_EMAIL, ADMIN_PASSWORD)
    return headers


async def _make_user(client, admin_headers, email):
    return (await create_user_via_admin(client, admin_headers, email, "user-pass-123!"))["uid"]


def _masked(key):
    return "********" + key[-4:]


async def test_default_gemini_seeded_from_env(client):
    headers = await _admin_headers(client)
    resp = await client.get("/api/v1/auth/admin/settings/ai-providers", headers=headers)
    assert resp.status_code == 200
    providers = resp.json()["providers"]
    assert "gemini" in providers
    gemini = providers["gemini"]
    assert gemini["enabled"] is True
    assert gemini["api_key"] == _masked("pytest-dummy-api-key")
    assert gemini["model_id"] == "gemini-3.1-flash-lite-preview"
    assert gemini["thinking_mode"] is False


async def test_all_implemented_providers_returned(client):
    headers = await _admin_headers(client)
    resp = await client.get("/api/v1/auth/admin/settings/ai-providers", headers=headers)
    assert resp.status_code == 200
    providers = resp.json()["providers"]
    assert set(providers.keys()) == {"gemini", "deepseek", "openrouter", "qwen"}
    for provider, cfg in providers.items():
        assert cfg["enabled"] is True
        assert cfg["model_id"], f"{provider} should carry a default model"
        assert cfg["thinking_mode"] is False


async def test_admin_put_sets_and_masks_provider_key(client):
    headers = await _admin_headers(client)
    resp = await client.put(
        "/api/v1/auth/admin/settings/ai-providers",
        headers=headers,
        json={"providers": {"deepseek": {"api_key": "sk-deepseek-1234", "enabled": True}}},
    )
    assert resp.status_code == 200
    deepseek = resp.json()["providers"]["deepseek"]
    assert deepseek["api_key"] == _masked("sk-deepseek-1234")
    assert deepseek["model_id"] == "deepseek-v4-flash"
    assert deepseek["thinking_mode"] is False

    stored = await admin_keys_service.get_admin_provider_config()
    assert stored["deepseek"]["api_key"] == "sk-deepseek-1234"


async def test_thinking_mode_persisted(client):
    headers = await _admin_headers(client)
    resp = await client.put(
        "/api/v1/auth/admin/settings/ai-providers",
        headers=headers,
        json={
            "providers": {
                "deepseek": {
                    "api_key": "sk-deepseek-1234",
                    "enabled": True,
                    "model_id": "deepseek-v4-flash",
                    "thinking_mode": True,
                }
            }
        },
    )
    assert resp.status_code == 200
    assert resp.json()["providers"]["deepseek"]["thinking_mode"] is True
    stored = await admin_keys_service.get_admin_provider_config()
    assert stored["deepseek"]["thinking_mode"] is True


async def test_keys_stored_encrypted(client):
    headers = await _admin_headers(client)
    await client.put(
        "/api/v1/auth/admin/settings/ai-providers",
        headers=headers,
        json={"providers": {"deepseek": {"api_key": "sk-secret-9876", "enabled": True}}},
    )

    from app.services.app_settings_service import get_setting

    raw = await get_setting(admin_keys_service.STORAGE_KEY)
    assert "sk-secret-9876" not in raw
    assert "sk-secret" not in raw


async def test_masked_key_keeps_existing_value(client):
    headers = await _admin_headers(client)
    await client.put(
        "/api/v1/auth/admin/settings/ai-providers",
        headers=headers,
        json={"providers": {"deepseek": {"api_key": "sk-deepseek-1234", "enabled": True}}},
    )
    resp = await client.put(
        "/api/v1/auth/admin/settings/ai-providers",
        headers=headers,
        json={"providers": {"deepseek": {"api_key": _masked("sk-deepseek-1234"), "model_id": "deepseek-v4-pro"}}},
    )
    assert resp.status_code == 200
    stored = await admin_keys_service.get_admin_provider_config()
    assert stored["deepseek"]["api_key"] == "sk-deepseek-1234"
    assert stored["deepseek"]["model_id"] == "deepseek-v4-pro"


async def test_empty_key_clears_provider(client):
    headers = await _admin_headers(client)
    await client.put(
        "/api/v1/auth/admin/settings/ai-providers",
        headers=headers,
        json={"providers": {"deepseek": {"api_key": "sk-deepseek-1234", "enabled": True}}},
    )
    resp = await client.put(
        "/api/v1/auth/admin/settings/ai-providers",
        headers=headers,
        json={"providers": {"deepseek": {"api_key": "", "enabled": True}}},
    )
    assert resp.status_code == 200
    stored = await admin_keys_service.get_admin_provider_config()
    assert stored["deepseek"]["api_key"] == ""


async def test_non_admin_cannot_manage_ai_providers(client):
    admin_headers = await _admin_headers(client)
    await create_user_via_admin(client, admin_headers, "ai-user@pytest.local", "user-pass-123!")

    user_headers, _, _ = await login(client, "ai-user@pytest.local", "user-pass-123!")
    resp = await client.get("/api/v1/auth/admin/settings/ai-providers", headers=user_headers)
    assert resp.status_code == 403
    resp = await client.put(
        "/api/v1/auth/admin/settings/ai-providers",
        headers=user_headers,
        json={"providers": {"deepseek": {"api_key": "sk-x"}}},
    )
    assert resp.status_code == 403
    resp = await client.post(
        "/api/v1/auth/admin/settings/ai-providers/test",
        headers=user_headers,
        json={"provider": "deepseek"},
    )
    assert resp.status_code == 403


async def test_test_connection_no_key_returns_400(client):
    headers = await _admin_headers(client)
    resp = await client.post(
        "/api/v1/auth/admin/settings/ai-providers/test",
        headers=headers,
        json={"provider": "qwen"},
    )
    assert resp.status_code == 400
    assert "qwen" in resp.json()["detail"]


async def test_test_connection_unsupported_provider_returns_400(client):
    headers = await _admin_headers(client)
    resp = await client.post(
        "/api/v1/auth/admin/settings/ai-providers/test",
        headers=headers,
        json={"provider": "openai"},
    )
    assert resp.status_code == 400
    assert "openai" in resp.json()["detail"]


async def test_resolution_errors_when_no_key(client):
    admin_headers = await _admin_headers(client)
    uid = await _make_user(client, admin_headers, "no-key@pytest.local")
    await DatabaseService.update_user_settings(uid, "ai_config", {"provider": "deepseek", "configs": {}})

    from app.services.gemini import get_gemini_config

    try:
        await get_gemini_config(uid)
        assert False, "expected ValueError for unprovisioned provider"
    except ValueError as e:
        assert "deepseek" in str(e)


async def test_resolution_falls_back_to_admin_key(client):
    admin_headers = await _admin_headers(client)
    uid = await _make_user(client, admin_headers, "fallback@pytest.local")
    await DatabaseService.update_user_settings(uid, "ai_config", {"provider": "deepseek", "configs": {}})

    await client.put(
        "/api/v1/auth/admin/settings/ai-providers",
        headers=admin_headers,
        json={"providers": {"deepseek": {"api_key": "sk-admin-fallback", "enabled": True}}},
    )

    from app.services.gemini import get_gemini_config

    api_key, model_id, provider = await get_gemini_config(uid)
    assert api_key == "sk-admin-fallback"
    assert provider == "deepseek"
    assert model_id == "deepseek-v4-flash"


async def test_resolution_prefers_user_key(client):
    admin_headers = await _admin_headers(client)
    uid = await _make_user(client, admin_headers, "own-key@pytest.local")
    own_key = encrypt_api_key("sk-user-own")
    await DatabaseService.update_user_settings(
        uid, "ai_config", {"provider": "deepseek", "configs": {"deepseek": {"api_key": own_key}}}
    )

    await client.put(
        "/api/v1/auth/admin/settings/ai-providers",
        headers=admin_headers,
        json={"providers": {"deepseek": {"api_key": "sk-admin-fallback", "enabled": True}}},
    )

    from app.services.gemini import get_gemini_config

    api_key, _, provider = await get_gemini_config(uid)
    assert api_key == "sk-user-own"
    assert provider == "deepseek"


async def test_disabled_admin_key_is_not_used(client):
    admin_headers = await _admin_headers(client)
    uid = await _make_user(client, admin_headers, "disabled-admin@pytest.local")
    await DatabaseService.update_user_settings(uid, "ai_config", {"provider": "deepseek", "configs": {}})

    await client.put(
        "/api/v1/auth/admin/settings/ai-providers",
        headers=admin_headers,
        json={"providers": {"deepseek": {"api_key": "sk-admin-off", "enabled": False}}},
    )

    from app.services.gemini import get_gemini_config

    try:
        await get_gemini_config(uid)
        assert False, "expected ValueError for disabled admin key"
    except ValueError:
        pass


async def test_admin_thinking_mode_used_as_fallback(client):
    admin_headers = await _admin_headers(client)
    uid = await _make_user(client, admin_headers, "thinking@pytest.local")
    await DatabaseService.update_user_settings(uid, "ai_config", {"provider": "deepseek", "configs": {}})

    await client.put(
        "/api/v1/auth/admin/settings/ai-providers",
        headers=admin_headers,
        json={
            "providers": {
                "deepseek": {"api_key": "sk-admin-think", "enabled": True, "thinking_mode": True}
            }
        },
    )

    from app.services.gemini import resolve_thinking_mode

    assert await resolve_thinking_mode(uid, "deepseek") is True


async def test_user_thinking_mode_wins_over_admin(client):
    admin_headers = await _admin_headers(client)
    uid = await _make_user(client, admin_headers, "think-user@pytest.local")
    await DatabaseService.update_user_settings(
        uid,
        "ai_config",
        {"provider": "deepseek", "configs": {"deepseek": {"thinking_mode": False}}},
    )

    await client.put(
        "/api/v1/auth/admin/settings/ai-providers",
        headers=admin_headers,
        json={
            "providers": {
                "deepseek": {"api_key": "sk-admin-think", "enabled": True, "thinking_mode": True}
            }
        },
    )

    from app.services.gemini import resolve_thinking_mode

    assert await resolve_thinking_mode(uid, "deepseek") is False
