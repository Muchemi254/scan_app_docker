"""
Scan App FastAPI Application

Serves as the backend for the Scan App receipt management system.

Architecture:
- Multi-tenant (per-user data isolation)
- Firebase Auth (validate tokens from frontend)
- PostgreSQL (data storage via asyncpg)
- Local filesystem (image storage)
- Gemini API (AI extraction)
- Redis + Celery (async batch processing)
- RESTful API with OpenAPI docs
"""

import logging
import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from app.core.config import settings
from app.api import health, receipts, tasks, images, batches, exports, cleaning, dashboard, review_batches, backup_api, scan_errors, settings as settings_api, auth as auth_api, admin_receipts, locations, ops, messages as messages_api, reports

# Configure logging
logging.basicConfig(
    level=getattr(logging, settings.LOG_LEVEL, logging.INFO),
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
logger = logging.getLogger(__name__)


# ============================================================================
# LIFESPAN EVENTS
# ============================================================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Handle startup and shutdown events.

    Startup: Initialize Firebase, log configuration
    Shutdown: Cleanup resources
    """
    # Startup
    logger.info(f"Starting {settings.API_TITLE} v{settings.API_VERSION}")

    # Enforce SECRET_KEY — refuse to start missing or with the default
    if not settings.SECRET_KEY or settings.SECRET_KEY == "change-me-in-production":
        logger.critical("SECRET_KEY must be a non-default value. Set SECRET_KEY env var.")
        raise RuntimeError("SECRET_KEY must be changed from default for security")

    # Local auth — refuse to bootstrap with the default admin password
    if settings.AUTH_MODE == "local" and (
        not settings.ADMIN_PASSWORD
        or settings.ADMIN_PASSWORD in ("admin12345", "change-me-admin-password")
    ):
        logger.critical(
            "ADMIN_PASSWORD is unset or still the default. Set ADMIN_PASSWORD env var."
        )
        raise RuntimeError("ADMIN_PASSWORD must be changed from default for security")

    logger.info(f"Auth Mode: {settings.AUTH_MODE}")
    logger.info(f"Firebase Credentials: {settings.FIREBASE_CREDENTIALS_PATH}")
    logger.info(f"CORS Origins: {settings.BACKEND_CORS_ORIGINS}")

    # Initialize PostgreSQL connection pool
    try:
        from app.core.database import init_pool
        await init_pool()
        logger.info("PostgreSQL pool initialized")
    except Exception as e:
        logger.error(f"Failed to initialize PostgreSQL pool: {e}")
        raise

    # Load admin-managed trusted hosts (persisted) into the request middleware
    try:
        from app.core import trusted_hosts
        await trusted_hosts.load_trusted_hosts()
    except Exception as e:
        logger.warning(f"Failed to seed trusted hosts: {e}")

    # Adopt GEMINI_API_KEY as the admin Gemini key on first start (if set).
    # Afterwards admin keys are managed via the admin UI — no implicit fallbacks.
    try:
        from app.services import admin_keys_service
        await admin_keys_service.seed_from_env()
    except Exception as e:
        logger.warning(f"Failed to seed admin AI keys: {e}")

    # Initialize authentication
    try:
        if settings.AUTH_MODE == "local":
            # Local auth — no Firebase, no internet required.
            from app.services.auth_service import bootstrap_admin
            await bootstrap_admin()
            logger.info("Local auth enabled — Firebase init skipped")
        else:
            from app.services.firebase_service import init_firebase
            init_firebase()
            logger.info("Firebase auth initialized successfully")
    except Exception as e:
        logger.error(f"Failed to initialize authentication: {e}")
        raise

    # Connect Redis
    try:
        from app.services.batch_service import get_redis
        await get_redis()
        logger.info("Redis connected successfully")
    except Exception as e:
        logger.warning(f"Redis connection failed (batch scanning will be unavailable): {e}")

    # Background cleanup: purge deleted users' data (rows + files) on a timer
    # so the admin delete endpoint stays fast. Idempotent + age-guarded.
    cleanup_task: asyncio.Task = None

    async def _cleanup_loop():
        await asyncio.sleep(settings.DATA_CLEANUP_INTERVAL_SECONDS)
        while True:
            try:
                from app.services import data_cleanup_service
                stats = await data_cleanup_service.cleanup_orphaned_data()
                if any(stats.values()):
                    logger.info("Background cleanup finished: %s", stats)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning(f"Background cleanup failed: {e}")
            # Watchdog: any op still "running" past its window (e.g. a delete
            # whose background task died) gets finalized so admin UIs stop
            # polling a phantom row forever.
            try:
                from app.services import ops_service
                stale = await ops_service.finalize_stale_ops(
                    "user_delete", max_age_seconds=settings.OP_STALE_AFTER_SECONDS
                )
                if stale:
                    logger.info("Finalized %d stale user-delete operation(s)", stale)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.warning(f"Stale-op watchdog failed: {e}")
            await asyncio.sleep(settings.DATA_CLEANUP_INTERVAL_SECONDS)

    try:
        cleanup_task = asyncio.create_task(_cleanup_loop())
        logger.info("Background data cleanup started (every %ds)", settings.DATA_CLEANUP_INTERVAL_SECONDS)
    except Exception as e:
        logger.warning(f"Could not start background data cleanup: {e}")

    yield

    # Shutdown
    logger.info("Shutting down application")
    if cleanup_task:
        cleanup_task.cancel()
        try:
            await cleanup_task
        except (asyncio.CancelledError, Exception):
            pass
    try:
        from app.core.database import close_pool
        await close_pool()
    except Exception:
        pass
    try:
        from app.services.batch_service import close_redis
        await close_redis()
    except Exception:
        pass


# ============================================================================
# APPLICATION FACTORY
# ============================================================================

def create_app() -> FastAPI:
    """
    Create and configure FastAPI application.

    Returns:
        Configured FastAPI instance
    """
    app = FastAPI(
        title=settings.API_TITLE,
        version=settings.API_VERSION,
        description="Multi-tenant receipt scanning and management API",
        docs_url="/docs" if settings.ENABLE_DOCS else None,
        redoc_url="/redoc" if settings.ENABLE_DOCS else None,
        openapi_url="/openapi.json" if settings.ENABLE_DOCS else None,
        lifespan=lifespan,
    )

    # ====================================================================
    # MIDDLEWARE
    # ====================================================================

    # CORS - Allow frontend to call backend
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins_list,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Trusted Host - Security (admin-managed, persisted — no hardcoded IPs)
    @app.middleware("http")
    async def trusted_host_check(request, call_next):
        from app.core import trusted_hosts
        host = request.headers.get("host", "")
        hostname = host.split(":")[0].lower() if host else ""
        if hostname and not trusted_hosts.allows(hostname):
            return JSONResponse(status_code=400, content={"detail": "Invalid host header"})
        return await call_next(request)

    # Security headers
    @app.middleware("http")
    async def add_security_headers(request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        return response

    # Request ID tracking for debugging / correlation
    @app.middleware("http")
    async def add_request_id(request, call_next):
        import uuid
        request_id = request.headers.get("X-Request-ID", str(uuid.uuid4())[:8])
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        return response

    # ====================================================================
    # ERROR HANDLERS
    # ====================================================================

    @app.exception_handler(RequestValidationError)
    async def validation_exception_handler(request, exc):
        """Handle validation errors with proper response format."""
        return JSONResponse(
            status_code=422,
            content={
                "detail": "Validation error",
                "errors": exc.errors()
            }
        )

    # ====================================================================
    # ROUTES
    # ====================================================================

    # Health checks
    app.include_router(health.router)

    # User <-> admin messaging (chat + SSE)
    app.include_router(
        messages_api.router,
        prefix=settings.API_V1_STR,
    )

    # Local authentication (login / me / admin user management)
    if settings.AUTH_MODE == "local":
        app.include_router(
            auth_api.router,
            prefix=settings.API_V1_STR,
        )
        # Admin-only cross-tenant supervision (approvals queue)
        app.include_router(
            admin_receipts.router,
            prefix=settings.API_V1_STR,
        )

    # Location reference data (authenticated list + admin write)
    app.include_router(
        locations.router,
        prefix=settings.API_V1_STR,
    )

    # Receipt API (main functionality)
    app.include_router(
        receipts.router,
        prefix=settings.API_V1_STR,
    )

    # Settings API (user configuration)
    app.include_router(
        settings_api.user_router,
        prefix=settings.API_V1_STR,
    )
    app.include_router(
        settings_api.global_router,
        prefix=settings.API_V1_STR,
    )

    # Task API (progress tracking)
    app.include_router(
        tasks.router,
        prefix=settings.API_V1_STR,
    )

    # Image utilities (HEIC conversion proxy, etc.)
    app.include_router(images.router)

    # Batch scanning (durable Postgres scan sessions; prep → hold → dispatch)
    app.include_router(
        batches.router,
        prefix=settings.API_V1_STR,
    )

    # Export (server-side report generation)
    app.include_router(
        exports.router,
        prefix=settings.API_V1_STR,
    )

    # Dashboard analytics (purpose-built KPIs, trends, breakdown, insights)
    app.include_router(
        dashboard.router,
        prefix=settings.API_V1_STR,
    )

    # Data cleaning (dedup, propagation, supplier merge)
    app.include_router(
        cleaning.router,
        prefix=settings.API_V1_STR,
    )

    # Comprehensive reporting & exports (every entity, masked by default)
    app.include_router(
        reports.router,
        prefix=settings.API_V1_STR,
    )

    # Review batches (SQLite-backed manual review workflow)
    app.include_router(
        review_batches.router,
        prefix=settings.API_V1_STR,
    )

    # Scan errors (durable, user-reviewable failure log)
    app.include_router(
        scan_errors.router,
        prefix=settings.API_V1_STR,
    )

    # Backup & restore
    app.include_router(
        backup_api.router,
        prefix=settings.API_V1_STR,
    )

    # Operation progress polling (imports, user deletions)
    app.include_router(
        ops.router,
        prefix=settings.API_V1_STR,
    )

    # ====================================================================
    # ROOT ENDPOINT
    # ====================================================================

    @app.get("/")
    async def root():
        """API information."""
        return {
            "name": settings.API_TITLE,
            "version": settings.API_VERSION,
            "status": "running",
            "docs": "/docs" if settings.ENABLE_DOCS else "disabled",
        }

    return app


# ============================================================================
# APPLICATION INSTANCE
# ============================================================================

app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host=settings.HOST,
        port=settings.PORT,
        reload=settings.RELOAD,
    )
