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
from app.services.search_query import (
    item_index_text,
    receipt_index_text,
    item_search_text,
    item_search_vector,
    like_pattern,
    receipt_search_vector,
)

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
        note=note,
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
    note: Optional[str] = None,
) -> None:
    """Handle workflow events in the message center.

    The inbox is reserved for crucial communication, so only a rejection
    auto-messages anyone (admin → owner, with the reason). Submit / recall /
    approve are visible on the approvals pages and must never flood the
    inbox with one bubble per receipt.

    Housekeeping stays best-effort so a messaging failure can never undo a
    successful transition:

    - resubmit / recall clear stale markers (a rejection is no longer true
      once the receipt is resubmitted; the chat only shows current state),
    - a repeat rejection keeps exactly one bubble (dedupe), so repeated
      events never pile up.
    """
    try:
        from app.services import messages_service

        if kind != "receipt_rejection":
            prune_kinds = {
                "receipt_submit":   ["receipt_rejection", "receipt_recall"],
                "receipt_recall":   ["receipt_rejection", "receipt_recall"],
                "receipt_approval": [],
            }[kind]
            if prune_kinds:
                await messages_service.prune_receipt_auto_messages(
                    receipt_id, prune_kinds
                )
            return  # nothing is sent to the inbox for these events

        if await messages_service.receipt_thread_has_kinds(receipt_id, ["receipt_rejection"]):
            return  # already notified — never a second rejection bubble

        body = (
            "Your receipt was rejected. "
            f"{note.strip()}  Please review the details and fix what's needed."
            if note and note.strip()
            else "Your receipt was rejected. Please review the details and resubmit when fixed."
        )

        payload = _receipt_notify_payload(receipt_id, receipt)
        payload["note"] = note
        await messages_service.send_message(
            actor_uid,
            owner_uid,
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
            r.image_filename                        AS image_filename,
            r.legacy_image_url                      AS legacy_image_url,
            (SELECT count(*) FROM line_items li
             WHERE li.receipt_id = r.id)           AS item_count,
            (NULLIF(BTRIM(r.image_filename), '') IS NOT NULL
             OR NULLIF(BTRIM(r.legacy_image_url), '') IS NOT NULL) AS has_image
    FROM receipts r
"""


def _search_vector() -> str:
    """The tsvector expression searched for a pending-approval query."""
    return f"""
        {receipt_search_vector('r')} @@ websearch_to_tsquery('simple', $2)
        OR {item_search_vector('li')} @@ websearch_to_tsquery('simple', $2)
    """


async def list_pending_for_admin(
    q: Optional[str] = None,
    limit: int = 1000,
    offset: int = 0,
    category: Optional[str] = None,
    batch_title: Optional[str] = None,
) -> dict:
    """Cross-tenant list of every pending-approval receipt (admin only).

    Carries the scalar fields an approver needs to decide at a glance
    (supplier, location, category, amounts, identifiers, timestamps and the
    item count) plus owner identity and an image flag — but never the full
    item payload.

    With `q`, reuses the same full-text matching used by the user-facing
    receipt search, scoped to pending approvals across all users.
    """
    query = (q or "").strip()
    receipt_index = receipt_index_text("r")
    item_index = item_index_text("li")
    item_text = item_search_text("li")
    where = ["r.status = $1"]
    args = [ReceiptStatus.PENDING_APPROVAL.value]
    if query:
        where.append(f"""(
            ({_search_vector()})
            OR {receipt_index} ILIKE '%' || $3 || '%' ESCAPE '\\'
            OR {item_index} ILIKE '%' || $3 || '%' ESCAPE '\\'
            OR r.receipt_date::text ILIKE '%' || $3 || '%' ESCAPE '\\'
            OR r.total_amount::text ILIKE '%' || $3 || '%' ESCAPE '\\'
            OR {item_text} ILIKE '%' || $3 || '%' ESCAPE '\\'
            OR (SELECT u.email FROM users u WHERE u.uid = r.user_id) ILIKE '%' || $3 || '%' ESCAPE '\\'
            OR (SELECT u.display_name FROM users u WHERE u.uid = r.user_id) ILIKE '%' || $3 || '%' ESCAPE '\\'
        )""")
        args.append(query)
        args.append(like_pattern(query))
    if category:
        args.append(category)
        where.append(f"r.category = ${len(args)}")
    if batch_title:
        args.append(batch_title)
        where.append(f"r.batch_title = ${len(args)}")
    limit_index = len(args) + 1
    offset_index = len(args) + 2
    args.extend([limit, offset])
    pool = await get_pool()
    async with pool.acquire() as conn:
        join = " LEFT JOIN line_items li ON li.receipt_id = r.id" if query else ""
        inner_sql = _PENDING_SELECT + f"""
            {join}
            WHERE {" AND ".join(where)}
            GROUP BY r.id
        """ if query else _PENDING_SELECT + f"""
            WHERE {" AND ".join(where)}
        """
        rows = await conn.fetch(
            f"""SELECT pending.*, COUNT(*) OVER() AS total
            FROM ({inner_sql}) AS pending
            ORDER BY pending.updated_at DESC NULLS LAST, pending.id
            LIMIT ${limit_index} OFFSET ${offset_index}
            """,
            *args,
        )
        total = rows[0]["total"] if rows else 0
        out = []
        for r in rows:
            d = dict(r)
            rid = str(d["id"])
            if d.pop("has_image"):
                image_url = f"/receipt-images/{rid}" if d.get("image_filename") else d.get("legacy_image_url")
            else:
                image_url = None
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
        return {"items": out, "total": total}
