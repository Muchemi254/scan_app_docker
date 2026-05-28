"""
Review batch API endpoints.

POST   /api/v1/users/{userId}/review-batches/upload   - Upload CSV, create batch
GET    /api/v1/users/{userId}/review-batches           - List batches
GET    /api/v1/users/{userId}/review-batches/{id}      - Get batch with receipt data
PUT    /api/v1/users/{userId}/review-batches/{id}/items/{receiptId}/status - Update review status
DELETE /api/v1/users/{userId}/review-batches/{id}      - Delete batch
POST   /api/v1/users/{userId}/review-batches/{id}/export - Export batch receipts
"""

import asyncio
import csv
import io
import logging
from datetime import datetime
from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import Response
from app.core.security import get_current_user_id
from app.services.review_batch_service import (
    init_db, create_batch, list_batches, get_batch, delete_batch,
    update_item_status, delete_item,
)
from app.services.data_adapter import DataService
from app.services.export_service import generate_export
from app.schemas.export import ExportRequest, ExportFormat

import httpx

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/users",
    tags=["review-batches"],
)


def _verify_access(user_id: str, current_user_id: str):
    if user_id != current_user_id:
        raise HTTPException(status_code=403, detail="Access denied")


@router.post("/{userId}/review-batches/upload", status_code=201)
async def upload_review_batch(
    userId: str,
    name: str = Form(...),
    file: UploadFile = File(...),
    current_user_id: str = Depends(get_current_user_id),
):
    """
    Upload a CSV file containing receipt IDs to create a review batch.

    CSV must have a header row with a column named 'receipt_id' (or similar).
    Each row's receipt ID is added to the batch for review.
    """
    _verify_access(userId, current_user_id)

    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Only CSV files are accepted")

    contents = await file.read()
    try:
        text = contents.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="File must be UTF-8 encoded")

    # Parse CSV — find the receipt_id column
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise HTTPException(status_code=400, detail="CSV appears to be empty")

    # Look for a header that might contain receipt IDs
    id_column = None
    for col in reader.fieldnames:
        normalized = col.strip().lower()
        if normalized in ("receipt_id", "receiptid", "id", "receipt id"):
            id_column = col
            break

    if not id_column:
        raise HTTPException(
            status_code=400,
            detail=f"CSV must have a receipt_id column. Found headers: {', '.join(reader.fieldnames)}",
        )

    receipt_ids = []
    for row in reader:
        rid = row.get(id_column, "").strip()
        if rid:
            receipt_ids.append(rid)

    if not receipt_ids:
        raise HTTPException(status_code=400, detail="No receipt IDs found in CSV")

    if len(receipt_ids) > 5000:
        raise HTTPException(status_code=400, detail="Maximum 5000 receipts per batch")

    batch = await create_batch(userId, name, receipt_ids, csv_filename=file.filename)
    logger.info(f"Created review batch {batch['id']} with {len(receipt_ids)} receipts for user {userId}")
    return batch


@router.get("/{userId}/review-batches")
async def list_review_batches(
    userId: str,
    current_user_id: str = Depends(get_current_user_id),
):
    """List all review batches for the user."""
    _verify_access(userId, current_user_id)
    return await list_batches(userId)


@router.get("/{userId}/review-batches/{batchId}")
async def get_review_batch(
    userId: str,
    batchId: str,
    current_user_id: str = Depends(get_current_user_id),
):
    """
    Get a review batch with full receipt data from Firestore.

    Each item includes the receipt's current data plus the review status from SQLite.
    """
    _verify_access(userId, current_user_id)

    batch = await get_batch(userId, batchId)
    if not batch:
        raise HTTPException(status_code=404, detail="Review batch not found")

    item_list = batch.get("items", [])
    if not item_list:
        result = {k: v for k, v in batch.items() if k != "items"}
        result["items"] = []
        return result

    # Fetch all receipts in one batch call
    receipt_ids = [item["receipt_id"] for item in item_list]
    try:
        receipts = await DataService.get_receipts_by_ids(userId, receipt_ids)
    except Exception:
        logger.exception("Batch fetch of receipts failed")
        receipts = []

    receipts_by_id = {r["id"]: r for r in receipts}

    enriched_items = []
    for item in item_list:
        receipt = receipts_by_id.get(item["receipt_id"])
        enriched = dict(item)
        if receipt:
            enriched["receipt"] = {
                "id": receipt.get("id", item["receipt_id"]),
                "supplier": receipt.get("supplier", ""),
                "totalAmount": receipt.get("totalAmount", ""),
                "taxAmount": receipt.get("taxAmount"),
                "receiptDate": receipt.get("receiptDate", ""),
                "category": receipt.get("category"),
                "invoiceNumber": receipt.get("invoiceNumber"),
                "kraPin": receipt.get("kraPin"),
                "buyerKraPin": receipt.get("buyerKraPin"),
                "cuInvoice": receipt.get("cuInvoice"),
                "batchTitle": receipt.get("batchTitle"),
                "status": receipt.get("status"),
                "imageUrl": receipt.get("imageUrl"),
                "thumbnailUrl": receipt.get("thumbnailUrl"),
                "items": receipt.get("items", []),
            }
        else:
            enriched["receipt"] = None
        enriched_items.append(enriched)

    result = {k: v for k, v in batch.items() if k != "items"}
    result["items"] = enriched_items
    return result


@router.put("/{userId}/review-batches/{batchId}/items/{receiptId}/status")
async def update_review_status(
    userId: str,
    batchId: str,
    receiptId: str,
    review_status: str = Query(...),
    notes: str = Query(default=""),
    current_user_id: str = Depends(get_current_user_id),
):
    """
    Update the review status of a receipt within a batch.

    Valid statuses: pending_review, in_review, reviewed, flagged
    """
    _verify_access(userId, current_user_id)

    valid = {"pending_review", "in_review", "reviewed", "flagged"}
    if review_status not in valid:
        raise HTTPException(status_code=400, detail=f"Invalid status. Must be one of: {', '.join(valid)}")

    result = await update_item_status(batchId, receiptId, review_status, notes or None)
    if not result:
        raise HTTPException(status_code=404, detail="Item not found in batch")

    return result


@router.delete("/{userId}/review-batches/{batchId}", status_code=204)
async def delete_review_batch(
    userId: str,
    batchId: str,
    current_user_id: str = Depends(get_current_user_id),
):
    """Delete a review batch and all its items."""
    _verify_access(userId, current_user_id)

    deleted = await delete_batch(userId, batchId)
    if not deleted:
        raise HTTPException(status_code=404, detail="Review batch not found")


@router.delete("/{userId}/review-batches/{batchId}/items/{receiptId}", status_code=204)
async def delete_review_batch_item(
    userId: str,
    batchId: str,
    receiptId: str,
    current_user_id: str = Depends(get_current_user_id),
):
    """Remove a single receipt from a review batch."""
    _verify_access(userId, current_user_id)

    deleted = await delete_item(batchId, receiptId)
    if not deleted:
        raise HTTPException(status_code=404, detail="Item not found in batch")


# ---------------------------------------------------------------------------
# Image prefetch — pre-cache all batch images in Redis for fast viewing
# ---------------------------------------------------------------------------

@router.post("/{userId}/review-batches/{batchId}/prefetch", status_code=202)
async def prefetch_batch_images(
    userId: str,
    batchId: str,
    current_user_id: str = Depends(get_current_user_id),
):
    """
    Start background prefetch of all receipt images in this batch.

    Fetches each image from Firebase Storage and caches it in Redis so
    subsequent views are instant.  Returns immediately — prefetch runs
    in the background with up to 10 parallel fetches.
    """
    _verify_access(userId, current_user_id)

    batch = await get_batch(userId, batchId)
    if not batch:
        raise HTTPException(status_code=404, detail="Review batch not found")

    receipt_ids = [item["receipt_id"] for item in batch.get("items", [])]
    if not receipt_ids:
        return {"status": "empty", "message": "No receipts in batch"}

    # Resolve image URLs from database
    try:
        receipts = await DataService.get_receipts_by_ids(userId, receipt_ids)
    except Exception:
        logger.exception("Failed to fetch receipts for prefetch")
        raise HTTPException(status_code=500, detail="Failed to fetch receipt data")

    image_urls = [r.get("imageUrl") for r in receipts if r.get("imageUrl")]
    if not image_urls:
        return {"status": "empty", "message": "No images to prefetch"}

    # Background prefetch: 10 parallel fetches, each cached in Redis
    async def _prefetch():
        sem = asyncio.Semaphore(10)
        cached = 0
        failed = 0

        async def _fetch_one(url: str):
            nonlocal cached, failed
            async with sem:
                try:
                    async with httpx.AsyncClient(timeout=30) as client:
                        resp = await client.get(url)
                        resp.raise_for_status()
                        raw = resp.content
                        ct = resp.headers.get("content-type", "image/jpeg")

                    if "heic" in ct.lower() or "heif" in ct.lower():
                        from app.services.image_service import process_image
                        raw, _ = process_image(raw, ct)

                    # Store in Redis via the same cache layer as /api/images/cached
                    try:
                        from app.services.batch_service import get_redis
                        r = await get_redis()
                        if r:
                            await r.setex(f"heic:img:{url}", 86400, raw)
                    except Exception:
                        pass

                    cached += 1
                except Exception:
                    failed += 1

        tasks = [_fetch_one(u) for u in image_urls]
        await asyncio.gather(*tasks, return_exceptions=True)
        logger.info(f"Batch {batchId} prefetch complete: {cached} cached, {failed} failed, {len(image_urls)} total")

    asyncio.create_task(_prefetch())

    return {"status": "started", "total_images": len(image_urls)}


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------

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


@router.post("/{userId}/review-batches/{batchId}/export")
async def export_review_batch(
    userId: str,
    batchId: str,
    body: ExportRequest,
    current_user_id: str = Depends(get_current_user_id),
):
    """
    Export receipts from a review batch.

    Uses the same export engine as /receipts/export but scoped to the
    receipt IDs in this batch.  Only receipts that still exist in Firestore
    are included.
    """
    _verify_access(userId, current_user_id)

    batch = await get_batch(userId, batchId)
    if not batch:
        raise HTTPException(status_code=404, detail="Review batch not found")

    receipt_ids = [item["receipt_id"] for item in batch.get("items", [])]
    if not receipt_ids:
        raise HTTPException(status_code=404, detail="Batch has no receipts")

    try:
        receipts = await DataService.get_receipts_by_ids(userId, receipt_ids)
    except Exception as e:
        logger.error(f"Failed to fetch batch receipts for export: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch receipt data")

    if not receipts:
        raise HTTPException(status_code=404, detail="None of the batch receipts were found in Firestore")

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
    filename = f"review_batch_{batchId}_{body.reportType.value}_{datetime.utcnow().strftime('%Y%m%d_%H%M%S')}.{ext}"
    content_type = CONTENT_TYPES.get(body.format, "application/octet-stream")

    return Response(
        content=file_bytes,
        media_type=content_type,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(len(file_bytes)),
        },
    )
