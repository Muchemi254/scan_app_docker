"""
Pytest configuration & shared fixtures.

IMPORTANT: the env vars below MUST be set before any `app.*` module is
imported, because app.core.config reads them at import time. That's why
app modules are imported inside fixtures/tests, never at the top of this
file.

The suite runs against a dedicated `scanapp_test` database (created and
migrated automatically). Every test starts with all tables truncated, so
tests are fully independent.
"""

import os
import subprocess

import pytest
import pytest_asyncio

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql://scanapp:scanapp_dev@localhost:5432/scanapp_test",
)

# --- Test configuration (set before importing app) ---------------------------
# Force (not setdefault) the deterministic values so tests are immune to the
# container's compose environment (e.g. ADMIN_EMAIL=admin@local).
os.environ["DATABASE_URL"] = TEST_DATABASE_URL
os.environ["SECRET_KEY"] = "pytest-secret-key-not-for-production-0123456789"
os.environ["ADMIN_EMAIL"] = "admin@pytest.local"
os.environ["ADMIN_PASSWORD"] = "admin-password-123!"
os.environ["GEMINI_API_KEY"] = "pytest-dummy-api-key"
os.environ.setdefault("USE_POSTGRES", "true")
os.environ.setdefault("AUTH_MODE", "local")
os.environ.setdefault("IMAGE_STORAGE_DIR", "/tmp/scanapp_pytest_images")
os.environ.setdefault("BACKUP_STORAGE_DIR", "/tmp/scanapp_pytest_backups")
os.environ.setdefault("REVIEW_BATCH_DB_PATH", "/tmp/scanapp_pytest_review.db")
os.environ.setdefault("ENABLE_DOCS", "false")
# Keep user-data cleanup deterministic in tests: the delete endpoint must not
# fire background purge tasks mid-suite. The cleanup service itself is tested
# directly (tests/test_data_cleanup.py).
os.environ.setdefault("SCHEDULE_DELETE_CLEANUP", "false")

_test_db_name = TEST_DATABASE_URL.rsplit("/", 1)[-1]

_TRUNCATE_TABLES = (
    "users",
    "receipts",
    "tasks",
    "scan_errors",
    "audit_logs",
    "line_items",
    "user_ai_settings",
    "app_settings",
    "scan_sessions",
    "locations",
    "user_preferences",
    "backups",
)


def _ensure_test_database():
    import asyncio
    import asyncpg

    async def create():
        admin_dsn = TEST_DATABASE_URL.rsplit("/", 1)[0] + "/postgres"
        conn = await asyncpg.connect(admin_dsn)
        try:
            exists = await conn.fetchval(
                "SELECT 1 FROM pg_database WHERE datname = $1", _test_db_name
            )
            if not exists:
                await conn.execute(f'CREATE DATABASE "{_test_db_name}"')
        finally:
            await conn.close()

    asyncio.run(create())


def _run_migrations():
    env = {**os.environ, "DATABASE_URL": TEST_DATABASE_URL}
    result = subprocess.run(
        ["alembic", "upgrade", "head"],
        cwd=BACKEND_DIR,
        env=env,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"alembic upgrade head failed:\n{result.stdout}\n{result.stderr}"
        )


def _truncate_all():
    import asyncio
    import asyncpg

    async def truncate():
        conn = await asyncpg.connect(TEST_DATABASE_URL)
        try:
            await conn.execute(
                f'TRUNCATE {", ".join(_TRUNCATE_TABLES)} RESTART IDENTITY CASCADE'
            )
        finally:
            await conn.close()

    asyncio.run(truncate())


@pytest.fixture(scope="session", autouse=True)
def prepared_database():
    """Create the test DB and apply migrations once per pytest session."""
    _ensure_test_database()
    _run_migrations()
    yield


@pytest.fixture(autouse=True)
def clean_database():
    """Truncate all tenant/auth tables before every test for isolation."""
    _truncate_all()
    yield


@pytest_asyncio.fixture
async def client():
    """Real FastAPI app with lifespan, served through an httpx async client."""
    from app.main import app
    from app.core import trusted_hosts
    from app.core.config import settings
    from httpx import AsyncClient, ASGITransport

    async with app.router.lifespan_context(app):
        # Reset the dynamic trusted-host registry so tests are isolated and the
        # persisted value (truncated below) doesn't leak from a previous test.
        trusted_hosts.reset()
        trusted_hosts.set_allowed_hosts(settings.allowed_hosts_list)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://localhost") as c:
            yield c
