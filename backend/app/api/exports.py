import logging
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import Response
from app.core.security import get_current_user_id
from app.schemas.export import ExportRequest, ExportFormat
from app.services.data_adapter import DataService
from app.services.export_service import generate_export

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/users",
    tags=["exports"],
)

CONTENT_TYPES = {
    ExportFormat.XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ExportFormat.PDF: "application/pdf",
    ExportFormat.CSV: "text/csv",
}

FILE_EXTENSIONS = {
    ExportFormat.XLSX: "xlsx",
    ExportFormat.PDF: "pdf",
    ExportFormat.CSV: "csv",
}


@router.post("/{userId}/receipts/export")
async def export_receipts(
    userId: str,
    body: ExportRequest,
    current_user_id: str = Depends(get_current_user_id),
):
    if userId != current_user_id:
        raise HTTPException(status_code=403, detail="Access denied")

    # Page through ALL matching receipts (metadata-only rows, cheap) instead
    # of a single hard-capped fetch, so "export the current filter" covers
    # the whole dataset regardless of size. Query filters pass straight to
    # list_receipts; the in-Python filters below (date/category/entryType/
    # q) apply on top exactly as the summary/table views do.
    try:
        receipts: list = []
        skip = 0
        page_size = 2000
        while True:
            page, _ = await DataService.list_receipts(
                userId, skip=skip, limit=page_size,
                status=body.status,
                category=body.category,
                batch_title=body.batchTitle,
                rejected=body.rejected,
                has_image=body.hasImage,
                has_pdf=body.hasPdf,
                entry_type=body.entryType,
            )
            if not page:
                break
            receipts.extend(page)
            if len(page) < page_size:
                break
            skip += page_size
    except Exception as e:
        logger.error(f"Failed to fetch receipts for export: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch receipt data")

    if not receipts:
        raise HTTPException(status_code=404, detail="No receipts found to export")

    # Non-expense handling: an explicit entryType selection wins; otherwise
    # non-expense entries (quotations/proformas/deposits/notes) are excluded
    # unless includeNonExpense is set.
    def _entry_type(r: dict) -> str:
        return r.get("entryType") or "expense"

    if body.entryType:
        if body.entryType == "non_expense":
            receipts = [r for r in receipts if _entry_type(r) != "expense"]
        else:
            receipts = [r for r in receipts if _entry_type(r) == body.entryType]
    elif not body.includeNonExpense:
        receipts = [r for r in receipts if _entry_type(r) == "expense"]

    # Search + date-range filters shared with the table view.
    if body.q:
        needle = body.q.strip().lower()
        receipts = [
            r for r in receipts
            if needle in str(r.get("supplier") or "").lower()
            or needle in str(r.get("invoiceNumber") or "").lower()
            or needle in str(r.get("category") or "").lower()
        ]
    if body.date_from or body.date_to:
        def _norm_date(s: str) -> str:
            try:
                parts = str(s).split("/")
                if len(parts) == 3:
                    return f"{parts[2]}-{parts[0].zfill(2)}-{parts[1].zfill(2)}"
                return str(s)
            except Exception:
                return str(s)

        receipts = [
            r for r in receipts
            if (not body.date_from
                or _norm_date(r.get("receiptDate") or "") >= body.date_from)
            and (not body.date_to
                or _norm_date(r.get("receiptDate") or "") <= body.date_to)
        ]

    if not receipts:
        raise HTTPException(status_code=404, detail="No receipts found for the selected filters")

    pivot_dict = None
    if body.pivotConfig:
        pivot_dict = {
            "rowField": body.pivotConfig.rowField.value,
            "colField": body.pivotConfig.colField.value,
            "valueField": body.pivotConfig.valueField.value,
        }

    try:
        file_bytes = generate_export(
            receipts,
            body.format.value,
            body.reportType.value,
            date_from=body.date_from,
            date_to=body.date_to,
            pivot_config=pivot_dict,
            columns=body.columns,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Export generation failed: {e}")
        raise HTTPException(status_code=500, detail="Export generation failed")

    ext = FILE_EXTENSIONS.get(body.format, "bin")
    filename = f"receipts_{body.reportType.value}_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.{ext}"
    content_type = CONTENT_TYPES.get(body.format, "application/octet-stream")

    return Response(
        content=file_bytes,
        media_type=content_type,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(len(file_bytes)),
        },
    )


from datetime import datetime
