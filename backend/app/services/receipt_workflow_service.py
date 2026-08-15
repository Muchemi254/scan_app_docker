"""
Receipt review → approval workflow.

A receipt moves through a controlled pipeline owned by an account user and
supervised by an administrator:

    needs_review ──submit──▶ pending_approval ──approve──▶ processed
         ▲                        │      ▲
         └────recall/reject───────┘      └──acknowledge acceptance

Rules (centralised here so both the status-update endpoint and the dedicated
transition endpoints behave identically):

  - OWNER (actor == owner uid): submit (needs_review → pending_approval) and
    recall (pending_approval → needs_review).
  - ADMIN: can drive any transition (submit, recall, approve, reject/amend).
  - approve and reject are admin-only.

Every transition is written to the audit trail with the acting user recorded
as changed_by; rejections may carry a human-readable note.
"""

from typing import Optional

import logging

from app.core.database import get_pool
from app.schemas.receipt import (
    ReceiptStatus,
    AuditAction,
    AuditFieldChange,
)
from app.services.data_adapter import DataService
from app.services.audit_service import AuditService
from app.services import auth_service

logger = logging.getLogger(__name__)

VALID_STATUSES = {
    ReceiptStatus.NEEDS_REVIEW.value,
    ReceiptStatus.PENDING_APPROVAL.value,
    ReceiptStatus.PROCESSED.value,
}


async def _is_admin(actor_uid: str) -> bool:
    user = await auth_service.get_user_by_uid(actor_uid)
    return bool(user and user["is_admin"])


async def is_admin_actor(actor_uid: str) -> bool:
    """Public helper: True when the actor is an admin (used by API guards)."""
    return await _is_admin(actor_uid)


async def assert_status_transition(
    current: str,
    target: str,
    actor_uid: str,
    owner_uid: str,
) -> None:
    """Raise HTTPException if the actor may not move an owned receipt's status."""
    from fastapi import HTTPException

    if current == target:
        return
    if target not in VALID_STATUSES:
        raise HTTPException(status_code=422, detail=f"Unknown status: {target}")

    if await _is_admin(actor_uid):
        return  # admins may drive any transition

    # Non-admin (owner) is limited to submit + recall on their own receipts.
    allowed = (
        (current == ReceiptStatus.NEEDS_REVIEW.value
         and target == ReceiptStatus.PENDING_APPROVAL.value
         and actor_uid == owner_uid)
        or
        (current == ReceiptStatus.PENDING_APPROVAL.value
         and target == ReceiptStatus.NEEDS_REVIEW.value
         and actor_uid == owner_uid)
    )
    if allowed:
        return

    raise HTTPException(
        status_code=403,
        detail="Status transition not permitted for this user",
    )


async def _transition(
    owner_uid: str,
    receipt_id: str,
    target: ReceiptStatus,
    prereq: ReceiptStatus,
    action: AuditAction,
    actor_uid: str,
    note: Optional[str] = None,
) -> dict:
    """Apply a validated, concurrency-safe status transition + audit entry.

    The status update is a guarded ``UPDATE ... WHERE status = prereq`` so two
    admins acting on the same receipt concurrently cannot double-apply — the
    second gets 409 instead of silently re-approving.
    """
    from fastapi import HTTPException

    current = await DataService.get_receipt(owner_uid, receipt_id)
    if not current:
        raise HTTPException(status_code=404, detail="Receipt not found")

    await assert_status_transition(
        current.get("status"), target.value, actor_uid, owner_uid
    )

    changes = [
        AuditFieldChange(
            field="status",
            old_value=current.get("status"),
            new_value=target.value,
        )
    ]
    if note:
        changes.append(AuditFieldChange(field="note", old_value=None, new_value=note))

    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE receipts
               SET status = $1, updated_at = now()
             WHERE id = $2 AND user_id = $3 AND status = $4
            RETURNING id
            """,
            target.value, str(receipt_id), owner_uid, prereq.value,
        )
    if row is None:
        raise HTTPException(
            status_code=409,
            detail="This receipt was changed by someone else first; refresh and try again",
        )

    await AuditService.log(
        owner_uid, receipt_id, action, actor_uid, changes=changes
    )
    updated = await DataService.get_receipt(owner_uid, receipt_id)
    return updated or current


async def submit(owner_uid: str, receipt_id: str, actor_uid: str) -> dict:
    """needs_review → pending_approval (owner or admin)."""
    return await _transition(
        owner_uid, receipt_id, ReceiptStatus.PENDING_APPROVAL,
        ReceiptStatus.NEEDS_REVIEW,
        AuditAction.SUBMITTED, actor_uid,
    )


async def recall(owner_uid: str, receipt_id: str, actor_uid: str) -> dict:
    """pending_approval → needs_review (owner or admin)."""
    return await _transition(
        owner_uid, receipt_id, ReceiptStatus.NEEDS_REVIEW,
        ReceiptStatus.PENDING_APPROVAL,
        AuditAction.RECALLED, actor_uid,
    )


async def approve(owner_uid: str, receipt_id: str, actor_uid: str) -> dict:
    """pending_approval → processed (admin only)."""
    if not await _is_admin(actor_uid):
        from fastapi import HTTPException
        raise HTTPException(
            status_code=403, detail="Admin privileges required to approve receipts"
        )
    return await _transition(
        owner_uid, receipt_id, ReceiptStatus.PROCESSED,
        ReceiptStatus.PENDING_APPROVAL,
        AuditAction.APPROVED, actor_uid,
    )


async def reject(
    owner_uid: str, receipt_id: str, actor_uid: str, note: Optional[str] = None
) -> dict:
    """pending_approval → needs_review (admin only), with optional note."""
    if not await _is_admin(actor_uid):
        from fastapi import HTTPException
        raise HTTPException(
            status_code=403, detail="Admin privileges required to reject receipts"
        )
    return await _transition(
        owner_uid, receipt_id, ReceiptStatus.NEEDS_REVIEW,
        ReceiptStatus.PENDING_APPROVAL,
        AuditAction.REJECTED, actor_uid, note=note,
    )


async def list_pending_for_admin() -> list:
    """Cross-tenant list of every pending-approval receipt (admin only).

    Deliberately lean: only the fields needed to make an approval decision,
    plus owner identity and an image flag — never the full receipt payload.
    """
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT r.id,
                   r.user_id                               AS owner_uid,
                   u.email                                 AS owner_email,
                   u.display_name                          AS owner_display_name,
                   r.supplier                              AS supplier,
                   r.receipt_date                          AS receipt_date,
                   r.total_amount                          AS total_amount,
                   r.status                                AS status,
                   r.updated_at                            AS updated_at,
                   r.created_at                            AS created_at,
                   (r.image_filename IS NOT NULL)          AS has_image
            FROM receipts r
            LEFT JOIN users u ON u.uid = r.user_id
            WHERE r.status = $1
            ORDER BY r.updated_at DESC
            """,
            ReceiptStatus.PENDING_APPROVAL.value,
        )
        out = []
        for r in rows:
            d = dict(r)
            rid = str(d["id"])
            image_url = f"/receipt-images/{rid}" if d.pop("has_image") else None
            out.append(
                {
                    "id": rid,
                    "owner_uid": d["owner_uid"],
                    "owner_email": d["owner_email"],
                    "owner_display_name": d["owner_display_name"],
                    "supplier": d["supplier"],
                    "receipt_date": d["receipt_date"],
                    "total_amount": d["total_amount"],
                    "status": d["status"],
                    "updated_at": d["updated_at"],
                    "created_at": d["created_at"],
                    "imageUrl": image_url,
                }
            )
        return out
