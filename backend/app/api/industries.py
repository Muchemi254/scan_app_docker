from fastapi import APIRouter, Depends, HTTPException, status
from app.core.security import get_current_user_id
from app.api.auth import require_admin
from app.schemas.industry import IndustryCreate, IndustryUpdate, IndustryOut, IndustryList
from app.services.data_adapter import DataService

router = APIRouter(prefix="/industries", tags=["industries"])

def _to_out(row: dict) -> IndustryOut:
    return IndustryOut(id=str(row["id"]), name=row["name"], description=row.get("description"), is_active=bool(row["is_active"]), is_system=bool(row.get("is_system", False)), created_by=row.get("created_by"), created_at=row["created_at"], updated_at=row.get("updated_at"))

@router.get("", response_model=IndustryList)
async def list_industries(_: str = Depends(get_current_user_id), active_only: bool = True):
    items = await DataService.list_industries(active_only=active_only)
    return IndustryList(items=[_to_out(r) for r in items], total=len(items))

@router.get("/all", response_model=IndustryList)
async def list_all_industries(_admin: str = Depends(require_admin)):
    items = await DataService.list_industries(active_only=False)
    return IndustryList(items=[_to_out(r) for r in items], total=len(items))

@router.post("", response_model=IndustryOut, status_code=status.HTTP_201_CREATED)
async def create_industry(body: IndustryCreate, admin_uid: str = Depends(require_admin)):
    row = await DataService.create_industry(body.name, body.description, created_by=admin_uid)
    if not row:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Industry with that name already exists")
    return _to_out(row)

@router.put("/{industryId}", response_model=IndustryOut)
async def update_industry(industryId: str, body: IndustryUpdate, _admin: str = Depends(require_admin)):
    updated = await DataService.update_industry(industryId, body.model_dump(exclude_unset=True))
    if not updated:
        ex = await DataService.get_industry(industryId)
        if not ex:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Industry not found")
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Industry with that name already exists")
    return _to_out(updated)

@router.delete("/{industryId}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_industry(industryId: str, _admin: str = Depends(require_admin)):
    row = await DataService.get_industry(industryId)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Industry not found")
    if row.get("is_system"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="System industries cannot be deleted (deactivate instead)")
    ok = await DataService.delete_industry(industryId)
    if not ok:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot delete: still has categories or receipts")
