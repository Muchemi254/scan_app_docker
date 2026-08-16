"""
Operation progress API (Redis-backed lightweight tracking).

GET /ops/{op_id}          Poll one operation's progress (own op, or any op for admins)
GET /ops/recent           Recent operations for the current user (import ops), or
                          admin-only view of user-delete ops

Owner rules:
  * backup-import ops are owned by the importing user
  * user-delete ops are owned by the *deleted* user — only admins can read them
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.security import get_current_user_id
from app.services import ops_service
from app.services.auth_service import get_user_by_uid

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ops", tags=["ops"])


async def _is_admin(uid: str) -> bool:
    user = await get_user_by_uid(uid)
    return bool(user and user.get("is_admin"))


def _visible(user_id: str, is_admin: bool, op: Optional[dict]) -> bool:
    if not op:
        return False
    if is_admin:
        return True
    return op.get("owner") == user_id


@router.get("/recent")
async def list_recent_operations(
    op_type: Optional[str] = Query(None),
    current_user_id: str = Depends(get_current_user_id),
):
    """Recent operations. Imports scoped to self; admins may also list user-delete ops."""
    is_admin = await _is_admin(current_user_id)
    if op_type == "user_delete" and not is_admin:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin only")
    return await ops_service.list_ops(current_user_id, op_type=op_type, limit=25)


@router.get("/{op_id}")
async def get_operation(op_id: str, current_user_id: str = Depends(get_current_user_id)):
    """Return live progress for one operation."""
    is_admin = await _is_admin(current_user_id)
    op = await ops_service.get_op(op_id)
    if not op:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Operation not found")
    if not _visible(current_user_id, is_admin, op):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Operation not found")
    return op