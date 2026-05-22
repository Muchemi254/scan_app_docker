import logging
from typing import Optional, List, Dict, Any
from datetime import datetime

from app.services.firebase_service import get_db
from app.schemas.receipt import AuditAction, AuditFieldChange, AuditEntry

logger = logging.getLogger(__name__)


class AuditService:

    COLLECTION = "audit"

    @staticmethod
    def _compute_changes(
        old_data: Optional[Dict[str, Any]],
        new_data: Dict[str, Any],
    ) -> List[AuditFieldChange]:
        changes = []
        old = old_data or {}
        tracked_fields = {
            "supplier", "totalAmount", "taxAmount", "receiptDate",
            "category", "invoiceNumber", "kraPin", "cuInvoice",
            "batchTitle", "status", "imageUrl", "items",
        }
        for field in tracked_fields:
            old_val = old.get(field)
            new_val = new_data.get(field)
            if old_val != new_val:
                changes.append(AuditFieldChange(
                    field=field,
                    old_value=old_val,
                    new_value=new_val,
                ))
        return changes

    @staticmethod
    async def log(
        user_id: str,
        receipt_id: str,
        action: AuditAction,
        changed_by: str,
        changes: Optional[List[AuditFieldChange]] = None,
    ) -> str:
        doc_ref = get_db().collection(
            f"users/{user_id}/receipts/{receipt_id}/{AuditService.COLLECTION}"
        ).document()

        entry = {
            "action": action.value,
            "changed_by": changed_by,
            "timestamp": datetime.utcnow(),
            "changes": [c.model_dump() for c in changes] if changes else [],
        }
        doc_ref.set(entry)
        logger.info(f"Audit: {action.value} receipt {receipt_id} by {changed_by}")
        return doc_ref.id

    @staticmethod
    async def get_audit_trail(
        user_id: str,
        receipt_id: str,
    ) -> List[Dict[str, Any]]:
        docs = (
            get_db()
            .collection(f"users/{user_id}/receipts/{receipt_id}/{AuditService.COLLECTION}")
            .order_by("timestamp", direction="DESCENDING")
            .stream()
        )
        results = []
        for doc in docs:
            data = doc.to_dict()
            data["id"] = doc.id
            data["receipt_id"] = receipt_id
            results.append(data)
        return results

    @staticmethod
    async def log_create(
        user_id: str,
        receipt_id: str,
        created_data: Dict[str, Any],
        changed_by: str,
    ):
        await AuditService.log(
            user_id, receipt_id, AuditAction.CREATED, changed_by,
            changes=[AuditFieldChange(field=k, old_value=None, new_value=v)
                     for k, v in created_data.items()],
        )

    @staticmethod
    async def log_update(
        user_id: str,
        receipt_id: str,
        old_data: Dict[str, Any],
        new_data: Dict[str, Any],
        changed_by: str,
    ):
        changes = AuditService._compute_changes(old_data, new_data)
        if not changes:
            return
        await AuditService.log(
            user_id, receipt_id, AuditAction.UPDATED, changed_by, changes=changes,
        )

    @staticmethod
    async def log_delete(
        user_id: str,
        receipt_id: str,
        deleted_data: Dict[str, Any],
        changed_by: str,
    ):
        await AuditService.log(
            user_id, receipt_id, AuditAction.DELETED, changed_by,
            changes=[AuditFieldChange(field=k, old_value=v, new_value=None)
                     for k, v in deleted_data.items()],
        )
