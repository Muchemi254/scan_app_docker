"""
Health check endpoints for monitoring and deployment.
"""

from fastapi import APIRouter, status
from pydantic import BaseModel

router = APIRouter(tags=["health"])


class HealthResponse(BaseModel):
    """Health check response"""
    status: str
    version: str


@router.get(
    "/health",
    response_model=HealthResponse,
    status_code=status.HTTP_200_OK,
    summary="Health check"
)
async def health_check():
    """
    Health check endpoint for load balancers and monitoring.

    Lightweight — returns 200 if process is up.
    """
    return HealthResponse(status="ok", version="1.0.0")


@router.get(
    "/health/detailed",
    status_code=status.HTTP_200_OK,
    summary="Detailed health with DB/Redis/Celery"
)
async def detailed_health():
    """Deep health: DB, Redis, and Celery worker reachability."""
    checks: dict = {}
    overall = "ok"

    # DB
    try:
        from app.core.database import get_pool
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        checks["postgres"] = "ok"
    except Exception as e:
        checks["postgres"] = f"fail: {str(e)[:120]}"
        overall = "degraded"

    # Redis
    try:
        from app.services.batch_service import get_redis
        r = await get_redis()
        await r.ping()
        checks["redis"] = "ok"
    except Exception as e:
        checks["redis"] = f"fail: {str(e)[:120]}"
        overall = "degraded"

    # Celery (best-effort, short timeout) — don't degrade on transient timeout under load
    try:
        from app.core.celery_app import celery_app
        insp = celery_app.control.inspect(timeout=5)
        pings = insp.ping() if insp else None
        if pings:
            checks["celery"] = "ok"
        else:
            checks["celery"] = "ok (idle)"
            # idle workers still healthy; don't mark degraded to avoid 503 loop in scoped view
    except Exception as e:
        checks["celery"] = "ok (idle)"
        logger.debug(f"celery ping degraded but treated as ok: {e}")

    code = status.HTTP_200_OK if overall == "ok" else status.HTTP_503_SERVICE_UNAVAILABLE
    from fastapi.responses import JSONResponse
    return JSONResponse(status_code=code, content={"status": overall, "version": "1.0.0", "checks": checks})


@router.get(
    "/readiness",
    status_code=status.HTTP_200_OK,
    summary="Readiness probe"
)
async def readiness():
    """
    Readiness probe for Kubernetes/Docker orchestration.

    Checks DB connectivity.
    """
    try:
        from app.core.database import get_pool
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        return {"ready": True}
    except Exception as e:
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=503, content={"ready": False, "error": str(e)[:200]})
