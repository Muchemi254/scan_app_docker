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
