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

    Returns 200 if service is healthy.
    """
    return HealthResponse(status="ok", version="1.0.0")


@router.get(
    "/readiness",
    status_code=status.HTTP_200_OK,
    summary="Readiness probe"
)
async def readiness():
    """
    Readiness probe for Kubernetes/Docker orchestration.

    Returns 200 if service is ready to handle requests.
    """
    # Could add checks for database connectivity, etc.
    return {"ready": True}
