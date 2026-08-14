"""Admin-managed shared AI provider keys.

Stored (encrypted) in app_settings under the key 'admin_provider_keys' as JSON:

    {
      "<provider>": {"api_key": "<encrypted>", "enabled": bool,
                     "model_id": str, "thinking_mode": bool}
    }

Key resolution for any extraction call is explicit — never implicit:

    1. the user's own key for the active provider (user_ai_settings)
    2. the admin-provided shared key for that provider (if enabled)
    3. a clear error telling the user to add a key or contact an administrator

There is deliberately NO silent fallback to a default provider/key so no one
can burn money on a provider that was never explicitly provisioned.
"""

import json
import logging
from typing import Dict, Optional

from app.core.config import settings
from app.core.encryption import encrypt_api_key, decrypt_api_key

logger = logging.getLogger(__name__)

STORAGE_KEY = "admin_provider_keys"

# All providers the app implements — the admin UI exposes one card per provider.
ALL_PROVIDERS = ("gemini", "deepseek", "openrouter", "qwen")


def default_model_for(provider: str) -> str:
    """Return the app's default model id for a provider (registry-first)."""
    if provider == "gemini":
        return "gemini-3.1-flash-lite-preview"
    from app.services.model_registry import MODELS

    models = MODELS.get(provider) or []
    return models[0]["id"] if models else ""


async def get_admin_provider_config() -> dict:
    """Return {provider: {api_key(plaintext), enabled, model_id, thinking_mode}} for all providers."""
    from app.services.app_settings_service import get_setting

    raw = await get_setting(STORAGE_KEY)
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except (ValueError, TypeError):
        logger.warning("Corrupt %s value in app_settings", STORAGE_KEY)
        return {}

    out: dict = {}
    for provider, cfg in data.items():
        if not isinstance(cfg, dict):
            continue
        out[provider] = {
            "api_key": decrypt_api_key(cfg.get("api_key") or ""),
            "enabled": bool(cfg.get("enabled", True)),
            "model_id": cfg.get("model_id") or default_model_for(provider),
            "thinking_mode": bool(cfg.get("thinking_mode", False)),
        }
    return out


async def set_admin_provider_config(config: dict) -> None:
    """Persist {provider: {api_key, enabled, model_id, thinking_mode}}; api_key is encrypted on write."""
    from app.services.app_settings_service import set_setting

    payload: dict = {}
    for provider, cfg in config.items():
        api_key = cfg.get("api_key") or ""
        payload[provider] = {
            "api_key": encrypt_api_key(api_key),
            "enabled": bool(cfg.get("enabled", True)),
            "model_id": cfg.get("model_id") or "",
            "thinking_mode": bool(cfg.get("thinking_mode", False)),
        }
    await set_setting(STORAGE_KEY, json.dumps(payload))


async def get_provider_override(provider: str) -> Optional[dict]:
    config = await get_admin_provider_config()
    return config.get(provider)


async def seed_from_env() -> None:
    """One-time adoption of GEMINI_API_KEY as the admin's Gemini key.

    Only runs while the admin has not yet managed any provider keys, so an
    admin who later disables or clears Gemini is never silently re-provisioned.
    """
    config = await get_admin_provider_config()
    if config:
        return
    if not settings.GEMINI_API_KEY:
        return
    logger.info("Seeding admin Gemini key from GEMINI_API_KEY env")
    await set_admin_provider_config(
        {"gemini": {"api_key": settings.GEMINI_API_KEY, "enabled": True, "model_id": "", "thinking_mode": False}}
    )
