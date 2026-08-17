"""Persistent key/value application settings backed by the app_settings table.

Values are JSON-encoded strings so any structured setting (e.g. the
trusted-hosts whitelist) can be stored and reloaded across restarts.
"""

import json
import logging
from typing import List, Optional

logger = logging.getLogger(__name__)

KEY_TRUSTED_HOSTS = "trusted_hosts"
KEY_DEFAULT_TAX_RATE = "default_tax_rate"
KEY_BACKUP_MAX_BYTES = "max_backup_bytes_per_user"
KEY_BACKUP_MAX_COUNT = "max_backups_per_user"
KEY_AI_SUMMARY_ENABLED = "ai_summary_enabled"


async def get_setting(key: str) -> Optional[str]:
    from app.core.database import get_pool

    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT value FROM app_settings WHERE key = $1", key
        )
        return row["value"] if row else None


async def set_setting(key: str, value: str) -> None:
    from app.core.database import get_pool

    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO app_settings (key, value) VALUES ($1, $2)
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
            """,
            key,
            value,
        )


async def get_trusted_hosts() -> Optional[List[str]]:
    raw = await get_setting(KEY_TRUSTED_HOSTS)
    if raw is None:
        return None
    try:
        hosts = json.loads(raw)
        return [h for h in hosts if isinstance(h, str)] if isinstance(hosts, list) else None
    except (ValueError, TypeError):
        logger.warning("Corrupt trusted_hosts value in app_settings: %r", raw)
        return None


async def set_trusted_hosts(hosts: List[str]) -> None:
    await set_setting(KEY_TRUSTED_HOSTS, json.dumps(hosts))


async def get_backup_limits() -> dict:
    """Return the effective backup limits (admin-tunable, env defaults as fallback)."""
    from app.core.config import settings

    max_bytes = settings.BACKUP_MAX_BYTES_PER_USER
    max_count = settings.BACKUP_MAX_COUNT_PER_USER
    raw_bytes = await get_setting(KEY_BACKUP_MAX_BYTES)
    raw_count = await get_setting(KEY_BACKUP_MAX_COUNT)
    if raw_bytes:
        try:
            max_bytes = int(float(raw_bytes))
        except (ValueError, TypeError):
            pass
    if raw_count:
        try:
            max_count = int(raw_count)
        except (ValueError, TypeError):
            pass
    return {
        "max_backup_bytes_per_user": max(max_bytes, 0),
        "max_backups_per_user": max(max_count, 0),
    }


async def set_backup_limits(max_backup_bytes_per_user: int, max_backups_per_user: int) -> dict:
    await set_setting(KEY_BACKUP_MAX_BYTES, str(int(max_backup_bytes_per_user)))
    await set_setting(KEY_BACKUP_MAX_COUNT, str(int(max_backups_per_user)))
    return await get_backup_limits()


async def get_ai_summary_enabled() -> bool:
    """Global AI-summary switch. Disabled by default to avoid surprise LLM spend."""
    raw = await get_setting(KEY_AI_SUMMARY_ENABLED)
    if raw is None:
        return False
    return raw.strip().lower() in ("1", "true", "yes", "on")


async def set_ai_summary_enabled(enabled: bool) -> None:
    await set_setting(KEY_AI_SUMMARY_ENABLED, "1" if enabled else "0")
