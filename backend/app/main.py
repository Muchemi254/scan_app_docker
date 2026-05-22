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
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from app.core.config import settings
from app.api import health, receipts, tasks, images, batches, exports, cleaning, dashboard, review_batches, backup_api, settings as settings_api

# Configure logging
logging.basicConfig(
    level=logging.INFO,
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

    # Initialize Firebase Auth (token validation only)
    try:
        from app.services.firebase_service import init_firebase
        init_firebase()
        logger.info("Firebase auth initialized successfully")
    except Exception as e:
        logger.error(f"Failed to initialize Firebase auth: {e}")
        raise

    # Connect Redis
    try:
        from app.services.batch_service import get_redis
        await get_redis()
        logger.info("Redis connected successfully")
    except Exception as e:
        logger.warning(f"Redis connection failed (batch scanning will be unavailable): {e}")

    yield

    # Shutdown
    logger.info("Shutting down application")
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
        allow_origins=settings.BACKEND_CORS_ORIGINS,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # Trusted Host - Security
    app.add_middleware(
        TrustedHostMiddleware,
        allowed_hosts=settings.ALLOWED_HOSTS,
    )

    # Security headers
    @app.middleware("http")
    async def add_security_headers(request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
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

    # Batch scanning (Redis-backed, survives frontend refresh)
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

    # Review batches (SQLite-backed manual review workflow)
    app.include_router(
        review_batches.router,
        prefix=settings.API_V1_STR,
    )

    # Backup & restore
    app.include_router(
        backup_api.router,
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
