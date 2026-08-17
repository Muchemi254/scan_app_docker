"""
Admin-only receipt endpoints (cross-tenant supervision).

These operate across every user's tenant. Access is gated by require_admin
(local auth mode only) — non-admins get 403. The global Approvals page in the
frontend consumes these to review all pending-approval receipts across users.
"""

from fastapi import APIRouter, Depends, Query
from typing import Optional

from app.api.auth import require_admin
from app.services.receipt_workflow_service import list_pending_for_admin

router = APIRouter(prefix="/admin", tags=["admin-receipts"])


@router.get("/receipts/pending-approval")
async def list_pending_approval(
    q: Optional[str] = Query(None, description="Full-text search within pending approvals"),
    _: str = Depends(require_admin),
):
    """List every pending_approval receipt across all users (admin only)."""
    items = await list_pending_for_admin(q)
    return {"items": items, "total": len(items)}
