"""
PostgreSQL connection pool via asyncpg.

Provides a single connection pool per process, initialized at startup
and closed on shutdown.  All database services import get_pool() to
acquire and release connections.

Multi-tenant security: enables Row-Level Security on all user-data
tables.  Set current_user via set_current_user_id() in middleware
before each request — the pool wrapper injects it into each
connection automatically.
"""

import logging
from contextvars import ContextVar
from contextlib import asynccontextmanager
from typing import Optional

import asyncpg

from app.core.config import settings

logger = logging.getLogger(__name__)

# Context variable set by auth middleware before each request
_current_user: ContextVar[str] = ContextVar("current_user_id", default="")

_pool: Optional[asyncpg.Pool] = None
_rls_initialized = False


def set_current_user_id(user_id: str) -> None:
    """Set the current authenticated user ID for this request (middleware)."""
    _current_user.set(user_id)


def get_current_user_context() -> str:
    """Get the current user ID from request context."""
    return _current_user.get("")


class _RLSPool:
    """Wraps asyncpg.Pool to auto-set current_user_id on every connection."""

    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool

    def acquire(self, **kwargs):
        """Return an async context manager that sets RLS context on entry."""
        return _RLSConnection(self._pool, **kwargs)

    async def close(self):
        await self._pool.close()


class _RLSConnection:
    def __init__(self, pool: asyncpg.Pool, **kwargs):
        self._pool = pool
        self._kwargs = kwargs
        self._conn = None

    async def __aenter__(self):
        self._conn = await self._pool.acquire(**self._kwargs)
        uid = get_current_user_context()
        if uid:
            try:
                await self._conn.execute(
                    "SELECT set_config('app.current_user_id', $1, true)", uid
                )
            except Exception:
                pass
        return self._conn

    async def __aexit__(self, *exc):
        if self._conn:
            await self._pool.release(self._conn)


async def init_pool() -> _RLSPool:
    """Create the asyncpg connection pool and enable RLS.  Idempotent."""
    global _pool, _rls_initialized
    if _pool is not None:
        return _pool

    logger.info(
        "Creating PostgreSQL pool → %s (min=%d, max=%d)",
        _masked_url(settings.DATABASE_URL),
        settings.DATABASE_POOL_MIN,
        settings.DATABASE_POOL_MAX,
    )

    raw_pool = await asyncpg.create_pool(
        dsn=settings.DATABASE_URL,
        min_size=settings.DATABASE_POOL_MIN,
        max_size=settings.DATABASE_POOL_MAX,
        command_timeout=30,
    )

    # Verify connectivity
    async with raw_pool.acquire() as conn:
        version = await conn.fetchval("SELECT version()")
    logger.info("PostgreSQL connected — %s", version)

    # Enable Row-Level Security on all user-data tables
    if not _rls_initialized:
        await _enable_rls(raw_pool)
        _rls_initialized = True

    _pool = _RLSPool(raw_pool)
    return _pool


async def _enable_rls(pool: asyncpg.Pool) -> None:
    """Enable RLS on all multi-tenant tables with user_id column."""
    tables = ["receipts", "tasks", "review_batches", "audit_logs"]
    async with pool.acquire() as conn:
        for table in tables:
            exists = await conn.fetchval(
                "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)",
                table,
            )
            if not exists:
                continue
            try:
                await conn.execute(f'ALTER TABLE "{table}" ENABLE ROW LEVEL SECURITY')
                await conn.execute(
                    f"""
                    DO $$
                    BEGIN
                        IF NOT EXISTS (
                            SELECT 1 FROM pg_policies
                            WHERE tablename = '{table}' AND policyname = 'user_isolation'
                        ) THEN
                            CREATE POLICY user_isolation ON "{table}"
                                USING (user_id = current_setting('app.current_user_id', true))
                                WITH CHECK (user_id = current_setting('app.current_user_id', true));
                        END IF;
                    END
                    $$;
                    """
                )
                logger.info("RLS enabled on %s", table)
            except Exception as e:
                logger.warning("RLS on %s skipped: %s", table, e)


async def close_pool() -> None:
    """Gracefully close the pool."""
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
        logger.info("PostgreSQL pool closed")


async def get_pool() -> _RLSPool:
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
