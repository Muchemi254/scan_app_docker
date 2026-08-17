import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Response, status

from app.core.security import get_current_user_id
from app.schemas.report import ReportFormat, ReportRunRequest
from app.services import auth_service
from app.services import reports_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/reports", tags=["reports"])


def _file_extension(fmt: str) -> str:
    return fmt


async def _is_admin(current_uid: str) -> bool:
    user = await auth_service.get_user_by_uid(current_uid)
    return bool(user and user.get("is_admin"))


@router.get("", summary="List available reports")
async def list_reports(
    current_uid: str = Depends(get_current_user_id),
):
    is_admin = await _is_admin(current_uid)
    return {
        "reports": await reports_service.list_report_defs(is_admin),
        "formats": [f.value for f in ReportFormat],
        "maxRows": reports_service.MAX_ROWS,
    }


@router.post("/{report_key}/export", summary="Run a report and download it")
async def run_report_export(
    report_key: str,
    body: ReportRunRequest,
    current_uid: str = Depends(get_current_user_id),
):
    is_admin = await _is_admin(current_uid)
    try:
        payload = await reports_service.run_report(
            current_uid=current_uid,
            is_admin=is_admin,
            key=report_key,
            report_format=body.format.value,
            date_from=body.dateFrom,
            date_to=body.dateTo,
            include_sensitive=body.includeSensitive,
            filters=body.filters or {},
        )
    except LookupError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
    except PermissionError as e:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.exception("Report %s failed", report_key)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Report failed: {e}",
        )

    renderer = reports_service.RENDERERS.get(body.format.value)
    if renderer is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported format: {body.format.value}",
        )
    content = renderer(payload)
    content_type = reports_service.CONTENT_TYPES.get(body.format.value, "application/octet-stream")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    filename = f"report_{report_key}_{stamp}.{_file_extension(body.format.value)}"
    return Response(
        content=content,
        media_type=content_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )