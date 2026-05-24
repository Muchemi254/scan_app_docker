"""
Receipt API endpoints.

Resource-based RESTful API:
POST   /api/v1/users/{userId}/receipts/extract      - Extract from image
POST   /api/v1/users/{userId}/receipts              - Create receipt
GET    /api/v1/users/{userId}/receipts              - List receipts
GET    /api/v1/users/{userId}/receipts/{id}         - Get receipt
PUT    /api/v1/users/{userId}/receipts/{id}         - Update receipt
DELETE /api/v1/users/{userId}/receipts/{id}         - Delete receipt
POST   /api/v1/users/{userId}/receipts/search       - Search receipts
POST   /api/v1/users/{userId}/receipts/summary      - Generate AI summary
"""

import logging
from typing import Optional
import json
from fastapi import APIRouter, Depends, File, Form, UploadFile, HTTPException, status, Query
from app.core.config import settings
from app.core.security import get_current_user_id
from app.schemas.receipt import (
    ReceiptCreate, Receipt, ReceiptList, ReceiptGroup, ReceiptGroupList,
    ReceiptUpdate,
    DuplicateCheckRequest, DuplicateCheckResponse, DuplicateMatch,
    AuditEntry, AuditList, SpendingSummaryRequest, SpendingSummaryResponse,
    CategoryBreakdown, SupplierBreakdown, MonthlyTrend,
)
from app.services.data_adapter import DataService
from app.services.database_service import save_image, save_thumbnail, delete_receipt_images
from app.services.firebase_service import StorageService
from app.services.gemini import extract_receipt_data, generate_ai_summary
from app.services.image_service import process_image, generate_thumbnail
from app.services.task_service import TaskService
from app.services.audit_service import AuditService
from app.tasks.worker import extract_receipt_batch_task
from app.schemas.task import TaskType

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/users",
    tags=["receipts"],
)


def verify_user_access(user_id: str, current_user_id: str):
    """
    Verify that current user can access user_id's data.

    Multi-tenant security: users can only access their own data.
    """
    if user_id != current_user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied: cannot access other user's data"
        )


# ============================================================================
# EXTRACT & CREATE ENDPOINTS
# ============================================================================

@router.post(
    "/{userId}/receipts/batch-extract",
    status_code=status.HTTP_202_ACCEPTED,
    summary="Asynchronous batch receipt extraction"
)
async def batch_extract_receipts(
    userId: str,
    files: list[UploadFile] = File(...),
    current_user_id: str = Depends(get_current_user_id),
):
    """
    Queue batch receipt extraction asynchronously.
    """
    verify_user_access(userId, current_user_id)

    # 1. Create task
    task_id = await TaskService.create_task(
        userId, TaskType.EXTRACTION, "Batch Extraction", len(files)
    )

    # 1.5 Get current provider settings
    ai_settings = await DataService.get_user_settings(userId, "ai_config")
    provider = ai_settings.get("provider", "gemini") if ai_settings else "gemini"

    # 2. Process files
    processed_images = []
    for file in files:
        contents = await file.read()
        if len(contents) > settings.MAX_UPLOAD_SIZE:
            raise HTTPException(status_code=413, detail=f"File too large: {file.filename}")
        processed, processed_type = process_image(contents, file.content_type or "image/jpeg")
        import base64
        base64_data = base64.standard_b64encode(processed).decode()
        processed_images.append((base64_data, processed_type))

    # 3. Dispatch Celery task
    extract_receipt_batch_task.delay(userId, task_id, processed_images, provider=provider)

    # 4. Return task ID
    return {"task_id": task_id}

@router.post(
    "/{userId}/receipts/extract",
    response_model=ReceiptCreate,
    status_code=status.HTTP_200_OK,
    summary="Extract receipt data from image",
    description="Upload receipt image, extract data via Gemini AI, return structured data"
)
async def extract_receipt_from_image(
    userId: str,
    file: UploadFile = File(...),
    current_user_id: str = Depends(get_current_user_id),
):
    """
    Extract receipt data from uploaded image using Gemini Vision.

    This endpoint:
    1. Reads the uploaded image
    2. Sends to Gemini for AI extraction
    3. Returns structured receipt data (NOT saved)

    The frontend can review and POST to /receipts to save.

    Args:
        userId: User ID from URL
        file: Image file (JPEG, PNG, HEIC)
        current_user_id: Authenticated user ID

    Returns:
        ReceiptCreate schema with extracted data
    """
    # Verify access
    verify_user_access(userId, current_user_id)

    try:
        # Validate file type (HEIC/HEIF accepted — converted server-side)
        allowed = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"}
        if not file.content_type or file.content_type not in allowed:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unsupported file type: {file.content_type}"
            )

        # Read file
        contents = await file.read()
        if len(contents) > settings.MAX_UPLOAD_SIZE:
            raise HTTPException(status_code=413, detail="File too large")

        # Optimize: convert HEIC→JPEG, resize, compress
        processed, processed_type = process_image(contents, file.content_type or "image/jpeg")

        # Convert to base64 for Gemini
        import base64
        base64_data = base64.standard_b64encode(processed).decode()

        # Extract using Gemini (always sends JPEG now)
        receipt = await extract_receipt_data(base64_data, processed_type, userId)

        return receipt

    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.error(f"Extraction failed: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Image extraction failed"
        )


@router.post(
    "/{userId}/receipts",
    response_model=Receipt,
    status_code=status.HTTP_201_CREATED,
    summary="Create new receipt"
)
async def create_receipt(
    userId: str,
    receipt_data: str = Form(...),
    file: Optional[UploadFile] = File(None),
    current_user_id: str = Depends(get_current_user_id),
):
    """
    Create a new receipt.
    receipt_data: JSON-encoded ReceiptCreate (sent as a single form field).
    """
    verify_user_access(userId, current_user_id)

    try:
        parsed = ReceiptCreate.model_validate(json.loads(receipt_data))
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Invalid receipt_data: {e}")

    try:
        # Pre-generate receipt ID
        import uuid as _uuid
        receipt_id = str(_uuid.uuid4())

        # Upload image if provided
        image_url = parsed.imageUrl
        image_filename = None
        if file:
            file_contents = await file.read()
            if len(file_contents) > settings.MAX_UPLOAD_SIZE:
                raise HTTPException(status_code=413, detail="File too large")
            processed, _ = process_image(
                file_contents, file.content_type or "image/jpeg"
            )
            thumb = generate_thumbnail(file_contents, file.content_type or "image/jpeg")

            if settings.USE_POSTGRES:
                image_filename = save_image(receipt_id, processed)
                if thumb:
                    save_thumbnail(receipt_id, thumb)
            else:
                base = f"receipt_{int(datetime.utcnow().timestamp())}"
                image_url, _ = await StorageService.upload_receipt_images(
                    userId, base, processed, thumb,
                )

        # Prepare data for storage
        data = parsed.model_dump(exclude_unset=True)
        data["userId"] = userId
        if settings.USE_POSTGRES:
            if image_filename:
                data["image_filename"] = image_filename
        else:
            if image_url:
                data["imageUrl"] = image_url

        receipt_id = await DataService.create_receipt(user_id=userId, receipt_data={**data, "id": receipt_id})

        # Audit log
        await AuditService.log_create(userId, receipt_id, data, current_user_id)

        # Fetch and return created receipt
        created = await DataService.get_receipt(userId, receipt_id)
        return Receipt(**created)

    except Exception as e:
        logger.error(f"Failed to create receipt: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create receipt"
        )


# ============================================================================
# READ ENDPOINTS
# ============================================================================

@router.get(
    "/{userId}/receipts",
    response_model=ReceiptList,
    summary="List user's receipts"
)
async def list_receipts(
    userId: str,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=1000),
    status_filter: Optional[str] = Query(None, alias="status"),
    category: Optional[str] = Query(None),
    batch_title: Optional[str] = Query(None, alias="batchTitle"),
    current_user_id: str = Depends(get_current_user_id),
):
    """
    List receipts with pagination and filters.

    Args:
        userId: User ID
        skip: Number to skip (pagination)
        limit: Number to return (max 1000)
        status_filter: Filter by status (processed, needs_review)
        category: Filter by category
        batch_title: Filter by batchTitle (for gallery groupings)
        current_user_id: Authenticated user

    Returns:
        Paginated receipt list
    """
    verify_user_access(userId, current_user_id)

    try:
        receipts, total = await DataService.list_receipts(
            userId, skip=skip, limit=limit, status=status_filter,
            category=category, batch_title=batch_title,
        )

        return ReceiptList(
            items=[Receipt(**r) for r in receipts],
            total=total,
            skip=skip,
            limit=limit,
        )

    except Exception as e:
        logger.error(f"Failed to list receipts: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list receipts"
        )


@router.get(
    "/{userId}/receipts/groups",
    response_model=ReceiptGroupList,
    summary="List receipt groups for gallery"
)
async def list_receipt_groups(
    userId: str,
    current_user_id: str = Depends(get_current_user_id),
):
    """
    Return receipts grouped by batchTitle for gallery browsing.

    Each group includes a count, thumbnail URL, total amount, and latest date.
    Only receipts with images are included.
    """
    verify_user_access(userId, current_user_id)
    try:
        groups = await DataService.get_receipt_groups(userId)
        return ReceiptGroupList(
            groups=[ReceiptGroup(**g) for g in groups]
        )
    except Exception as e:
        logger.error(f"Failed to list receipt groups: {e}")
        raise HTTPException(status_code=500, detail="Failed to list receipt groups")


@router.get(
    "/{userId}/receipts/search",
    summary="Full-text search across receipts and items"
)
async def search_receipts_endpoint(
    userId: str,
    q: str = Query(..., min_length=1, description="Search query"),
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    current_user_id: str = Depends(get_current_user_id),
):
    """
    Search receipts by any attribute: supplier, invoice, KRA PIN, CU invoice,
    batch title, category, date, amount, or item names.
    Returns ranked results with relevance scores.
    """
    verify_user_access(userId, current_user_id)
    try:
        result = await DataService.search_receipts_fulltext(userId, q, limit, offset)
        return result
    except Exception as e:
        logger.error(f"Search failed: {e}")
        raise HTTPException(status_code=500, detail="Search failed")


@router.get(
    "/{userId}/receipts/{receiptId}",
    response_model=Receipt,
    summary="Get single receipt"
)
async def get_receipt(
    userId: str,
    receiptId: str,
    current_user_id: str = Depends(get_current_user_id),
):
    """Get a single receipt by ID."""
    verify_user_access(userId, current_user_id)

    try:
        receipt = await DataService.get_receipt(userId, receiptId)

        if not receipt:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Receipt not found"
            )

        return Receipt(**receipt)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to get receipt: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get receipt"
        )


# ============================================================================
# UPDATE & DELETE ENDPOINTS
# ============================================================================

@router.put(
    "/{userId}/receipts/{receiptId}",
    response_model=Receipt,
    summary="Update receipt"
)
async def update_receipt(
    userId: str,
    receiptId: str,
    receipt_data: str = Form(...),
    file: Optional[UploadFile] = File(None),
    current_user_id: str = Depends(get_current_user_id),
):
    """Update a receipt. receipt_data: JSON-encoded ReceiptUpdate form field."""
    verify_user_access(userId, current_user_id)

    try:
        updates = ReceiptUpdate.model_validate(json.loads(receipt_data))
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Invalid receipt_data: {e}")

    try:
        # Get current receipt
        current = await DataService.get_receipt(userId, receiptId)
        if not current:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Receipt not found"
            )

        # Upload new image if provided
        image_url = current.get("imageUrl")
        if file:
            file_contents = await file.read()
            if len(file_contents) > settings.MAX_UPLOAD_SIZE:
                raise HTTPException(status_code=413, detail="File too large")
            processed, _ = process_image(
                file_contents, file.content_type or "image/jpeg"
            )
            thumb = generate_thumbnail(file_contents, file.content_type or "image/jpeg")

            if settings.USE_POSTGRES:
                image_filename = save_image(receiptId, processed)
                if thumb:
                    save_thumbnail(receiptId, thumb)
            else:
                base = f"receipt_{int(datetime.utcnow().timestamp())}"
                image_url, _ = await StorageService.upload_receipt_images(
                    userId, base, processed, thumb,
                )

        # Prepare update data
        data = updates.model_dump(exclude_unset=True)
        if file:
            if settings.USE_POSTGRES:
                data["image_filename"] = image_filename
            else:
                data["imageUrl"] = image_url

        # Audit log before update
        await AuditService.log_update(userId, receiptId, current, data, current_user_id)

        # Update
        await DataService.update_receipt(userId, receiptId, data)

        # Return updated
        updated = await DataService.get_receipt(userId, receiptId)
        return Receipt(**updated)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to update receipt: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update receipt"
        )


@router.delete(
    "/{userId}/receipts/{receiptId}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete receipt"
)
async def delete_receipt(
    userId: str,
    receiptId: str,
    current_user_id: str = Depends(get_current_user_id),
):
    """Delete a receipt."""
    verify_user_access(userId, current_user_id)

    try:
        # Get receipt to delete image
        receipt = await DataService.get_receipt(userId, receiptId)
        if not receipt:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Receipt not found"
            )

        # Delete images
        if settings.USE_POSTGRES:
            delete_receipt_images(receiptId)
        elif receipt.get("imageUrl"):
            await StorageService.delete_receipt_image(receipt["imageUrl"])

        # Audit log before delete
        await AuditService.log_delete(userId, receiptId, receipt, current_user_id)

        # Delete document
        await DataService.delete_receipt(userId, receiptId)

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed to delete receipt: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to delete receipt"
        )


# ============================================================================
# ADVANCED ENDPOINTS
# ============================================================================





# ============================================================================
# SUMMARY & REPORTING
# ============================================================================


@router.post(
    "/{userId}/receipts/summary",
    response_model=SpendingSummaryResponse,
    summary="Generate spending summary and AI report"
)
async def generate_summary(
    userId: str,
    body: SpendingSummaryRequest,
    current_user_id: str = Depends(get_current_user_id),
):
    verify_user_access(userId, current_user_id)
    try:
        receipts, _ = await DataService.list_receipts(
            userId, skip=0, limit=5000,
        )

        # Apply filters (normalize MM/DD/YYYY to comparable format)
        def _parse_date(s: str):
            try:
                parts = s.split("/")
                if len(parts) == 3:
                    return f"{parts[2]}-{parts[0].zfill(2)}-{parts[1].zfill(2)}"
                return s
            except Exception:
                return s

        filtered = receipts
        if body.date_from:
            filtered = [r for r in filtered if _parse_date(r.get("receiptDate") or "") >= body.date_from]
        if body.date_to:
            filtered = [r for r in filtered if _parse_date(r.get("receiptDate") or "") <= body.date_to]
        if body.category:
            filtered = [r for r in filtered if r.get("category") == body.category]

        # Compute aggregates
        total_receipts = len(filtered)
        total_items = 0
        category_totals: dict[str, float] = {}
        category_counts: dict[str, int] = {}
        supplier_totals: dict[str, float] = {}
        supplier_counts: dict[str, int] = {}
        monthly_totals: dict[str, float] = {}
        monthly_counts: dict[str, int] = {}

        for r in filtered:
            amount = float(r.get("totalAmount", 0) or 0)
            cat = r.get("category") or "Other"
            sup = r.get("supplier") or "Unknown"
            date_str = r.get("receiptDate") or ""
            month = date_str[-4:] + "-" + date_str[:2] if len(date_str) >= 7 else "Unknown"

            items = r.get("items") or []
            total_items += len(items)

            category_totals[cat] = category_totals.get(cat, 0) + amount
            category_counts[cat] = category_counts.get(cat, 0) + 1
            supplier_totals[sup] = supplier_totals.get(sup, 0) + amount
            supplier_counts[sup] = supplier_counts.get(sup, 0) + 1
            monthly_totals[month] = monthly_totals.get(month, 0) + amount
            monthly_counts[month] = monthly_counts.get(month, 0) + 1

        total_spent = sum(category_totals.values())
        avg_per_receipt = round(total_spent / total_receipts, 2) if total_receipts else 0

        category_breakdown = [
            CategoryBreakdown(
                category=cat,
                total=round(tot, 2),
                count=category_counts[cat],
                percentage=round(tot / total_spent * 100, 1) if total_spent else 0,
            )
            for cat, tot in sorted(category_totals.items(), key=lambda x: -x[1])
        ]

        top_suppliers = [
            SupplierBreakdown(supplier=sup, total=round(tot, 2), count=supplier_counts[sup])
            for sup, tot in sorted(supplier_totals.items(), key=lambda x: -x[1])[:10]
        ]

        month_names = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
        monthly_trend = [
            MonthlyTrend(
                month=f"{month_names[int(m.split('-')[1])-1]} {m.split('-')[0]}" if "-" in m else m,
                total=round(tot, 2),
                count=monthly_counts[m],
            )
            for m, tot in sorted(monthly_totals.items())
        ]

        # Generate AI summary
        summary_input = "\n".join(
            f"{r.get('receiptDate','')}|{r.get('supplier','')}|{r.get('totalAmount',0)}|{r.get('category','Other')}"
            for r in filtered[:200]
        )
        ai_summary = await generate_ai_summary(summary_input)

        return SpendingSummaryResponse(
            total_spent=round(total_spent, 2),
            total_receipts=total_receipts,
            total_items=total_items,
            avg_per_receipt=avg_per_receipt,
            category_breakdown=category_breakdown,
            top_suppliers=top_suppliers,
            monthly_trend=monthly_trend,
            ai_summary=ai_summary,
        )
    except Exception as e:
        logger.error(f"Summary generation failed: {e}")
        raise HTTPException(status_code=500, detail="Summary generation failed")


# ============================================================================
# DUPLICATE CHECK & AUDIT
# ============================================================================

@router.post(
    "/{userId}/receipts/check-duplicate",
    response_model=DuplicateCheckResponse,
    summary="Check for duplicate receipts"
)
async def check_duplicate(
    userId: str,
    body: DuplicateCheckRequest,
    current_user_id: str = Depends(get_current_user_id),
):
    verify_user_access(userId, current_user_id)
    try:
        matches = await DataService.check_duplicate(
            userId,
            supplier=body.supplier,
            totalAmount=body.totalAmount,
            receiptDate=body.receiptDate,
            invoiceNumber=body.invoiceNumber,
            exclude_id=body.excludeId,
        )
        dupe_matches = [
            DuplicateMatch(
                id=m["id"],
                supplier=m.get("supplier", ""),
                totalAmount=m.get("totalAmount", ""),
                receiptDate=m.get("receiptDate", ""),
                invoiceNumber=m.get("invoiceNumber"),
                confidence=m.get("_confidence", "medium"),
            )
            for m in matches
        ]
        return DuplicateCheckResponse(
            is_duplicate=len(dupe_matches) > 0,
            matches=dupe_matches,
        )
    except Exception as e:
        logger.error(f"Duplicate check failed: {e}")
        raise HTTPException(status_code=500, detail="Duplicate check failed")


@router.get(
    "/{userId}/receipts/{receiptId}/audit",
    response_model=AuditList,
    summary="Get audit trail for a receipt"
)
async def get_audit_trail(
    userId: str,
    receiptId: str,
    current_user_id: str = Depends(get_current_user_id),
):
    verify_user_access(userId, current_user_id)
    try:
        entries = await AuditService.get_audit_trail(userId, receiptId)
        audit_items = [
            AuditEntry(
                id=e["id"],
                receipt_id=e["receipt_id"],
                action=e["action"],
                changed_by=e.get("changed_by", ""),
                timestamp=e["timestamp"],
                changes=e.get("changes", []),
            )
            for e in entries
        ]
        return AuditList(items=audit_items, total=len(audit_items))
    except Exception as e:
        logger.error(f"Failed to fetch audit trail: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch audit trail")


# Import datetime for timestamp
from datetime import datetime
