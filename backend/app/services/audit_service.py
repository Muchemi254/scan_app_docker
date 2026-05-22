import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any

from app.core.database import get_pool
from app.schemas.receipt import AuditAction, AuditFieldChange, AuditEntry

logger = logging.getLogger(__name__)


class AuditService:

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
        entry_id = str(uuid.uuid4())
        now = datetime.now(timezone.utc)
        changes_json = json.dumps(
            [c.model_dump() for c in changes] if changes else [],
            default=str,
        )

        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO audit_logs (id, receipt_id, user_id, action, changed_by, timestamp, changes)
                VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
                """,
                entry_id, receipt_id, user_id, action.value, changed_by, now, changes_json,
            )
        logger.info("Audit: %s receipt %s by %s", action.value, receipt_id, changed_by)
        return entry_id

    @staticmethod
    async def get_audit_trail(
        user_id: str,
        receipt_id: str,
    ) -> List[Dict[str, Any]]:
        pool = await get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT id, receipt_id, user_id, action, changed_by, timestamp, changes
                FROM audit_logs
                WHERE receipt_id = $1 AND user_id = $2
                ORDER BY timestamp DESC
                """,
                receipt_id, user_id,
            )
            results = []
            for r in rows:
                results.append({
                    "id": str(r["id"]),
                    "receipt_id": str(r["receipt_id"]),
                    "user_id": r["user_id"],
                    "action": r["action"],
                    "changed_by": r["changed_by"],
                    "timestamp": r["timestamp"],
                    "changes": r["changes"] or [],
                })
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
