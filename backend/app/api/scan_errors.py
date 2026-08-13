"""
Scan errors API — durable, user-reviewable log of failed batch/extraction runs.

GET    /api/v1/users/{userId}/scan-errors                    List errors
GET    /api/v1/users/{userId}/scan-errors/unread-count       Unread badge count
POST   /api/v1/users/{userId}/scan-errors/{errorId}/read     Mark one as read
POST   /api/v1/users/{userId}/scan-errors/read-all           Mark all as read
DELETE /api/v1/users/{userId}/scan-errors/{errorId}          Dismiss one
DELETE /api/v1/users/{userId}/scan-errors                    Clear all
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi import status as http_status

from app.core.security import get_current_user_id
from app.services import scan_error_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/users", tags=["scan-errors"])


def _verify_access(user_id: str, current_user_id: str) -> None:
    if user_id != current_user_id:
        raise HTTPException(status_code=403, detail="Access denied")


@router.get("/{userId}/scan-errors")
async def list_scan_errors(
    userId: str,
    current_user_id: str = Depends(get_current_user_id),
    limit: int = Query(default=100, ge=1, le=500),
):
    """List the user's recorded scan/batch errors, newest first."""
    _verify_access(userId, current_user_id)
    errors = await scan_error_service.list_errors(userId, limit=limit)
    return {"errors": errors, "total": len(errors)}


@router.get("/{userId}/scan-errors/unread-count")
async def get_unread_count(
    userId: str,
    current_user_id: str = Depends(get_current_user_id),
):
    """Unread error count for the header bell badge."""
    _verify_access(userId, current_user_id)
    unread = await scan_error_service.unread_count(userId)
    return {"unread": unread}


@router.post("/{userId}/scan-errors/{errorId}/read")
async def mark_one_read(
    userId: str,
    errorId: str,
    current_user_id: str = Depends(get_current_user_id),
):
    _verify_access(userId, current_user_id)
    ok = await scan_error_service.mark_read(userId, errorId)
    if not ok:
        raise HTTPException(status_code=404, detail="Error record not found")
    return {"ok": True}


@router.post("/{userId}/scan-errors/read-all")
async def mark_all_read(
    userId: str,
    current_user_id: str = Depends(get_current_user_id),
):
    _verify_access(userId, current_user_id)
    marked = await scan_error_service.mark_all_read(userId)
    return {"marked": marked}


@router.delete("/{userId}/scan-errors/{errorId}", status_code=http_status.HTTP_204_NO_CONTENT)
async def delete_one(
    userId: str,
    errorId: str,
    current_user_id: str = Depends(get_current_user_id),
):
    _verify_access(userId, current_user_id)
    ok = await scan_error_service.delete_error(userId, errorId)
    if not ok:
        raise HTTPException(status_code=404, detail="Error record not found")


@router.delete("/{userId}/scan-errors", status_code=http_status.HTTP_204_NO_CONTENT)
async def clear_all(
    userId: str,
    current_user_id: str = Depends(get_current_user_id),
):
    """Dismiss every recorded error for this user."""
    _verify_access(userId, current_user_id)
    await scan_error_service.clear_all(userId)