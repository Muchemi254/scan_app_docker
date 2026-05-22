import logging
from typing import List
from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException, status
from app.core.security import get_current_user_id
from app.services.data_adapter import DataService
from app.services.data_cleaning_service import generate_all_suggestions, apply_actions

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/users",
    tags=["cleaning"],
)


class CleaningAction(BaseModel):
    type: str
    canonical: str = ""
    field: str = ""
    value: str = ""
    receipt_ids: List[str] = []
    target_receipts: List[str] = []
    keep_id: str = ""
    delete_ids: List[str] = []


class ApplyCleaningRequest(BaseModel):
    actions: List[CleaningAction]


@router.get("/{userId}/receipts/clean/suggestions")
async def get_cleaning_suggestions(
    userId: str,
    current_user_id: str = Depends(get_current_user_id),
):
    if userId != current_user_id:
        raise HTTPException(status_code=403, detail="Access denied")

    try:
        receipts, _ = await DataService.list_receipts(userId, skip=0, limit=5000)
    except Exception as e:
        logger.error(f"Failed to fetch receipts for cleaning: {e}")
        raise HTTPException(status_code=500, detail="Failed to fetch receipts")

    try:
        suggestions = generate_all_suggestions(receipts)
        return suggestions
    except Exception as e:
        logger.error(f"Failed to generate cleaning suggestions: {e}")
        raise HTTPException(status_code=500, detail="Failed to analyze receipts")


@router.post("/{userId}/receipts/clean/apply")
async def apply_cleaning(
    userId: str,
    body: ApplyCleaningRequest,
    current_user_id: str = Depends(get_current_user_id),
):
    if userId != current_user_id:
        raise HTTPException(status_code=403, detail="Access denied")

    try:
        stats = await apply_actions(userId, [a.model_dump() for a in body.actions])
        return {"status": "ok", "stats": stats}
    except Exception as e:
        logger.error(f"Failed to apply cleaning actions: {e}")
        raise HTTPException(status_code=500, detail="Failed to apply changes")
