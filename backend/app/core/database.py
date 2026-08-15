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

import asyncio
import logging
from contextvars import ContextVar
from contextlib import asynccontextmanager
from typing import Optional, Tuple

import asyncpg

from app.core.config import settings

logger = logging.getLogger(__name__)

# Context variable set by auth middleware before each request
_current_user: ContextVar[str] = ContextVar("current_user_id", default="")

# Cache (loop, pool) tuples keyed by id(loop). See batch_service._redis_cache
# for the full rationale — same bug class: id() reuse across Celery tasks can
# return a dead pool from a previous task's closed event loop.
_pool_cache: dict[int, Tuple[asyncio.AbstractEventLoop, "_RLSPool"]] = {}
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
    """Create the asyncpg connection pool and enable RLS for the current loop. Idempotent per loop."""
    global _rls_initialized

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        raise RuntimeError("init_pool must be called within an active event loop")

    loop_id = id(loop)
    cached = _pool_cache.get(loop_id)
    if cached is not None:
        cached_loop, cached_pool = cached
        if cached_loop is loop and not loop.is_closed():
            return cached_pool
        # id() reused after a previous Celery task's loop was GC'd — drop it.
        _pool_cache.pop(loop_id, None)
        logger.info("Dropping stale Postgres pool for reused loop id %d", loop_id)

    logger.info(
        "Creating PostgreSQL pool for loop %d → %s (min=%d, max=%d)",
        loop_id,
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

    # Enable Row-Level Security once per process (tables are shared)
    if not _rls_initialized:
        await _enable_rls(raw_pool)
        _rls_initialized = True

    pool = _RLSPool(raw_pool)
    _pool_cache[loop_id] = (loop, pool)
    return pool


async def _enable_rls(pool: asyncpg.Pool) -> None:
    """Enable RLS on all multi-tenant tables with user_id column."""
    tables = [
        "receipts",
        "tasks",
        "review_batches",
        "audit_logs",
        "scan_errors",
        "scan_sessions",
        "scan_session_items",
        "user_ai_settings",
    ]
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
    """Gracefully close the pool for the current loop.

    Narrow exception handling: previous `except: pass` silently masked
    cleanup failures that allowed stale cache entries to persist across
    Celery tasks.
    """
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    loop_id = id(loop)
    cached = _pool_cache.pop(loop_id, None)
    if cached is None:
        return
    _, pool = cached
    try:
        await pool.close()
        logger.info("PostgreSQL pool for loop %d closed", loop_id)
    except Exception as e:
        logger.warning("close_pool: failed to close cleanly for loop %d: %s", loop_id, e)


async def get_pool() -> _RLSPool:
    """Return the pool for current loop, raising if not initialised."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        raise RuntimeError("get_pool must be called within an active event loop")

    loop_id = id(loop)
    cached = _pool_cache.get(loop_id)
    if cached is not None:
        cached_loop, cached_pool = cached
        if cached_loop is loop and not loop.is_closed():
            return cached_pool
        # Stale — drop it and fall through to init_pool which will validate again.
        _pool_cache.pop(loop_id, None)
        logger.info("Dropping stale Postgres pool for reused loop id %d", loop_id)

    # Auto-initialize if missing or just-dropped (safer for deep service calls)
    return await init_pool()


def _masked_url(url: str) -> str:
    """Strip password from DSN for logging."""
    try:
        return url[: url.index("@")] + "@" + url[url.index("@") + 1 :].split("/", 1)[1]
    except ValueError:
        return url
