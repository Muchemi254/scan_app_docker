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

    try:
        receipts, _ = await DataService.list_receipts(
            userId, skip=0, limit=5000,
        )
    except Exception as e:
        logger.error(f"Failed to fetch receipts for export: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch receipt data")

    if not receipts:
        raise HTTPException(status_code=404, detail="No receipts found to export")

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
