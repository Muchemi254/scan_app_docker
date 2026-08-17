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

from fastapi import HTTPException

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
    updated = await _transition(
        owner_uid, receipt_id, ReceiptStatus.PENDING_APPROVAL,
        ReceiptStatus.NEEDS_REVIEW,
        AuditAction.SUBMITTED, actor_uid,
    )
    await _notify_workflow(
        actor_uid, owner_uid, receipt_id, updated, "receipt_submit",
        submitted=True,
    )
    return updated


async def recall(owner_uid: str, receipt_id: str, actor_uid: str) -> dict:
    """pending_approval → needs_review (owner or admin)."""
    updated = await _transition(
        owner_uid, receipt_id, ReceiptStatus.NEEDS_REVIEW,
        ReceiptStatus.PENDING_APPROVAL,
        AuditAction.RECALLED, actor_uid,
    )
    await _notify_workflow(
        actor_uid, owner_uid, receipt_id, updated, "receipt_recall",
        submitted=False,
    )
    return updated


async def _location_present(receipt: dict) -> bool:
    """True when a receipt carries a usable location (non-blank manual value)."""
    return bool((receipt.get("location") or "").strip())


def location_required_for_processed() -> HTTPException:
    """The HTTPException raised when a receipt is finalized without a location."""
    return HTTPException(
        status_code=422,
        detail="A location is required before a receipt can be confirmed as fully processed",
    )


async def approve(owner_uid: str, receipt_id: str, actor_uid: str) -> dict:
    """pending_approval → processed (admin only)."""
    if not await _is_admin(actor_uid):
        raise HTTPException(
            status_code=403, detail="Admin privileges required to approve receipts"
        )
    current = await DataService.get_receipt(owner_uid, receipt_id)
    if not current:
        raise HTTPException(status_code=404, detail="Receipt not found")
    if not await _location_present(current):
        raise location_required_for_processed()
    updated = await _transition(
        owner_uid, receipt_id, ReceiptStatus.PROCESSED,
        ReceiptStatus.PENDING_APPROVAL,
        AuditAction.APPROVED, actor_uid,
    )
    await _notify_workflow(
        actor_uid, owner_uid, receipt_id, updated, "receipt_approval",
        submitted=True,
    )
    return updated


async def reject(
    owner_uid: str, receipt_id: str, actor_uid: str, note: Optional[str] = None
) -> dict:
    """pending_approval → needs_review (admin only), with optional note."""
    if not await _is_admin(actor_uid):
        from fastapi import HTTPException
        raise HTTPException(
            status_code=403, detail="Admin privileges required to reject receipts"
        )
    updated = await _transition(
        owner_uid, receipt_id, ReceiptStatus.NEEDS_REVIEW,
        ReceiptStatus.PENDING_APPROVAL,
        AuditAction.REJECTED, actor_uid, note=note,
    )
    await _notify_workflow(
        actor_uid, owner_uid, receipt_id, updated, "receipt_rejection",
        submitted=False, note=note,
    )
    return updated


def _receipt_notify_payload(receipt_id: str, receipt: dict, **extra) -> dict:
    """The rich payload attached to every receipt workflow message."""
    payload = {
        "receipt_id": str(receipt_id),
        "supplier": receipt.get("supplier"),
        "total_amount": receipt.get("totalAmount") or receipt.get("total_amount"),
        "receipt_date": receipt.get("receiptDate") or receipt.get("receipt_date"),
        "invoice_number": receipt.get("invoiceNumber") or receipt.get("invoice_number"),
        "status": receipt.get("status"),
        "line_items_count": len(receipt.get("items") or []),
        "thumbnail_url": receipt.get("thumbnailUrl")
        or (f"/receipt-images/{receipt_id}?thumb=1" if receipt.get("imageUrl") else None),
    }
    payload.update(extra)
    return payload


async def _notify_workflow(
    actor_uid: str,
    owner_uid: str,
    receipt_id: str,
    receipt: dict,
    kind: str,
    *,
    submitted: bool,
    note: Optional[str] = None,
) -> None:
    """Auto-message the workflow event (submit / recall / approve / reject).

    Audience:
    - reject / approve: always the admin → owner.
    - submit / recall by the OWNER: the owner's single locked-in admin (if any
      — with no admin contact there is no one to notify yet).
    - submit / recall by an ADMIN: the admin → owner.

    Best-effort: a messaging failure must never undo a successful transition.

    The chat is kept clean by pruning (only-when-necessary) rules:
    - resubmit clears stale rejections / recalls for the receipt,
    - each transition kind appears at most once per receipt (dedupe), so
      repeated events never pile up duplicate bubbles.
    """
    try:
        from app.services import messages_service

        # Stale markers to drop for this event, and the kind to dedupe on.
        prune_kinds, dedupe_kind = {
            "receipt_submit":    (["receipt_rejection", "receipt_recall"], "receipt_submit"),
            "receipt_recall":    (["receipt_submit", "receipt_rejection"], "receipt_recall"),
            "receipt_approval":  ([], "receipt_approval"),
            "receipt_rejection": ([], "receipt_rejection"),
        }[kind]
        if prune_kinds:
            await messages_service.prune_receipt_auto_messages(receipt_id, prune_kinds)
        if await messages_service.receipt_thread_has_kinds(receipt_id, [dedupe_kind]):
            return  # already notified for this state — nothing new to say

        supplier = receipt.get("supplier") or "receipt"
        total = receipt.get("totalAmount") or receipt.get("total_amount")
        total_txt = f"KES {total}" if total is not None else "KES 0.00"

        if kind == "receipt_approval":
            recipient = owner_uid
            body = (
                f"Your receipt from {supplier} ({total_txt}) was approved "
                "and is now fully processed."
            )
        elif kind == "receipt_rejection":
            recipient = owner_uid
            body = (
                "Your receipt was rejected. "
                f"{note.strip()}  Please review the details and fix what's needed."
                if note and note.strip()
                else "Your receipt was rejected. Please review the details and resubmit when fixed."
            )
        else:
            # submit / recall — the recipient depends on the actor.
            if await _is_admin(actor_uid):
                recipient = owner_uid
                if kind == "receipt_submit":
                    body = (
                        f"Your receipt from {supplier} ({total_txt}) was "
                        "submitted for approval."
                    )
                else:
                    body = (
                        f"Your receipt from {supplier} ({total_txt}) was recalled."
                    )
            else:
                locked = await messages_service._locked_admin_for(owner_uid)
                if not locked:
                    return  # no admin contact yet — nothing to notify
                recipient = locked
                if kind == "receipt_submit":
                    body = (
                        f"Receipt from {supplier} ({total_txt}) was submitted "
                        "for approval."
                    )
                else:
                    body = f"Receipt from {supplier} ({total_txt}) was recalled."

        payload = _receipt_notify_payload(receipt_id, receipt)
        payload["note"] = note
        await messages_service.send_message(
            actor_uid,
            recipient,
            body,
            kind=kind,
            payload=payload,
            receipt_id=str(receipt_id),
        )
    except Exception:
        logger.exception(
            "Failed to auto-message %s for receipt %s", kind, receipt_id
        )


_PENDING_SELECT = """
    SELECT r.id,
           r.user_id                               AS owner_uid,
           (SELECT u.email FROM users u
             WHERE u.uid = r.user_id)              AS owner_email,
           (SELECT u.display_name FROM users u
             WHERE u.uid = r.user_id)              AS owner_display_name,
           r.supplier                              AS supplier,
           r.location                              AS location,
           r.category                              AS category,
           r.receipt_date                          AS receipt_date,
           r.total_amount                          AS total_amount,
           r.tax_amount                            AS tax_amount,
           r.tax_rate                              AS tax_rate,
           r.invoice_number                        AS invoice_number,
           r.kra_pin                               AS kra_pin,
           r.buyer_kra_pin                         AS buyer_kra_pin,
           r.cu_invoice                            AS cu_invoice,
           r.batch_title                           AS batch_title,
           r.status                                AS status,
           r.scanned_at                            AS scanned_at,
           r.updated_at                            AS updated_at,
           r.created_at                            AS created_at,
           (SELECT count(*) FROM line_items li
             WHERE li.receipt_id = r.id)           AS item_count,
           (r.image_filename IS NOT NULL)          AS has_image
    FROM receipts r
"""


def _search_vector() -> str:
    """The tsvector expression searched for a pending-approval query."""
    return f"""
        to_tsvector('simple',
            COALESCE(r.supplier,'') || ' ' ||
            COALESCE(r.category,'') || ' ' ||
            COALESCE(r.invoice_number,'') || ' ' ||
            COALESCE(r.kra_pin,'') || ' ' ||
            COALESCE(r.buyer_kra_pin,'') || ' ' ||
            COALESCE(r.cu_invoice,'') || ' ' ||
            COALESCE(r.batch_title,'') || ' ' ||
            COALESCE(r.receipt_date::text,'') || ' ' ||
            COALESCE(r.location,'') || ' ' ||
            COALESCE(r.total_amount::text,'') || ' ' ||
            COALESCE(li.name,'')
        ) @@ websearch_to_tsquery('simple', $2)
    """


async def list_pending_for_admin(q: Optional[str] = None) -> list:
    """Cross-tenant list of every pending-approval receipt (admin only).

    Carries the scalar fields an approver needs to decide at a glance
    (supplier, location, category, amounts, identifiers, timestamps and the
    item count) plus owner identity and an image flag — but never the full
    item payload.

    With `q`, reuses the same full-text matching used by the user-facing
    receipt search, scoped to pending approvals across all users.
    """
    query = (q or "").strip()
    pool = await get_pool()
    async with pool.acquire() as conn:
        if query:
            rows = await conn.fetch(
                _PENDING_SELECT.replace("    FROM receipts r\n", "    FROM receipts r\n") + f"""
            LEFT JOIN line_items li ON li.receipt_id = r.id
            WHERE r.status = $1
              AND (
                {_search_vector()}
                OR r.supplier ILIKE '%' || $2 || '%'
                OR r.category ILIKE '%' || $2 || '%'
                OR r.invoice_number ILIKE '%' || $2 || '%'
                OR r.kra_pin ILIKE '%' || $2 || '%'
                OR r.buyer_kra_pin ILIKE '%' || $2 || '%'
                OR r.cu_invoice ILIKE '%' || $2 || '%'
                OR r.batch_title ILIKE '%' || $2 || '%'
                OR r.location ILIKE '%' || $2 || '%'
                OR r.receipt_date::text ILIKE '%' || $2 || '%'
                OR r.total_amount::text ILIKE '%' || $2 || '%'
                OR (SELECT u.email FROM users u WHERE u.uid = r.user_id) ILIKE '%' || $2 || '%'
                OR (SELECT u.display_name FROM users u WHERE u.uid = r.user_id) ILIKE '%' || $2 || '%'
                OR li.name ILIKE '%' || $2 || '%'
              )
            GROUP BY r.id
            ORDER BY r.updated_at DESC
            """,
                ReceiptStatus.PENDING_APPROVAL.value,
                query,
            )
        else:
            rows = await conn.fetch(
                _PENDING_SELECT + """
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
                    "location": d["location"],
                    "category": d["category"],
                    "receipt_date": d["receipt_date"],
                    "total_amount": d["total_amount"],
                    "tax_amount": d["tax_amount"],
                    "tax_rate": d["tax_rate"],
                    "invoice_number": d["invoice_number"],
                    "kra_pin": d["kra_pin"],
                    "buyer_kra_pin": d["buyer_kra_pin"],
                    "cu_invoice": d["cu_invoice"],
                    "batch_title": d["batch_title"],
                    "status": d["status"],
                    "scanned_at": d["scanned_at"],
                    "updated_at": d["updated_at"],
                    "created_at": d["created_at"],
                    "item_count": d["item_count"],
                    "imageUrl": image_url,
                }
            )
        return out
