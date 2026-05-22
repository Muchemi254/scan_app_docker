"""
PostgreSQL connection pool via asyncpg.

Provides a single connection pool per process, initialized at startup
and closed on shutdown.  All database services import get_pool() to
acquire and release connections.
"""

import logging
from typing import Optional

import asyncpg

from app.core.config import settings

logger = logging.getLogger(__name__)

_pool: Optional[asyncpg.Pool] = None


async def init_pool() -> asyncpg.Pool:
    """Create the asyncpg connection pool.  Idempotent — safe to call multiple times."""
    global _pool
    if _pool is not None:
        return _pool

    logger.info(
        "Creating PostgreSQL pool → %s (min=%d, max=%d)",
        _masked_url(settings.DATABASE_URL),
        settings.DATABASE_POOL_MIN,
        settings.DATABASE_POOL_MAX,
    )

    _pool = await asyncpg.create_pool(
        dsn=settings.DATABASE_URL,
        min_size=settings.DATABASE_POOL_MIN,
        max_size=settings.DATABASE_POOL_MAX,
        command_timeout=30,
    )

    # Verify connectivity
    async with _pool.acquire() as conn:
        version = await conn.fetchval("SELECT version()")
    logger.info("PostgreSQL connected — %s", version)

    return _pool


async def close_pool() -> None:
    """Gracefully close the pool."""
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
        logger.info("PostgreSQL pool closed")


async def get_pool() -> asyncpg.Pool:
    """Return the pool, raising if not initialised."""
    if _pool is None:
        raise RuntimeError("Database pool not initialised — call init_pool() first")
    return _pool


def _masked_url(url: str) -> str:
    """Strip password from DSN for logging."""
    try:
        return url[: url.index("@")] + "@" + url[url.index("@") + 1 :].split("/", 1)[1]
    except ValueError:
        return url
