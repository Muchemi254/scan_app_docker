from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query, status
from app.core.security import get_current_user_id
from app.api.auth import require_admin
from app.schemas.category import CategoryCreate, CategoryUpdate, CategoryOut, CategoryList
from app.services.data_adapter import DataService

router = APIRouter(prefix="/categories", tags=["categories"])

def _to_out(row: dict) -> CategoryOut:
    return CategoryOut(id=str(row["id"]), industry_id=str(row["industry_id"]), name=row["name"], label=row.get("label") or row["name"], parent_id=str(row["parent_id"]) if row.get("parent_id") else None, is_active=bool(row["is_active"]), is_system=bool(row.get("is_system", False)), sort_order=int(row.get("sort_order", 0)), created_by=row.get("created_by"), created_at=row["created_at"], updated_at=row.get("updated_at"))

@router.get("", response_model=CategoryList)
async def list_categories(industry_id: Optional[str] = Query(None), active_only: bool = True, search: Optional[str] = Query(None), _: str = Depends(get_current_user_id)):
    items = await DataService.list_categories(industry_id=industry_id, active_only=active_only, search=search)
    return CategoryList(items=[_to_out(r) for r in items], total=len(items))

@router.get("/all", response_model=CategoryList)
async def list_all_categories(industry_id: Optional[str] = Query(None), _admin: str = Depends(require_admin)):
    items = await DataService.list_categories(industry_id=industry_id, active_only=False)
    return CategoryList(items=[_to_out(r) for r in items], total=len(items))

@router.post("", response_model=CategoryOut, status_code=status.HTTP_201_CREATED)
async def create_category(body: CategoryCreate, admin_uid: str = Depends(require_admin)):
    row = await DataService.create_category(body.industry_id, body.name, body.label, body.parent_id, created_by=admin_uid)
    if not row:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Category with that name already exists in this industry or industry not found")
    return _to_out(row)

@router.put("/{categoryId}", response_model=CategoryOut)
async def update_category(categoryId: str, body: CategoryUpdate, _admin: str = Depends(require_admin)):
    updated = await DataService.update_category(categoryId, body.model_dump(exclude_unset=True))
    if not updated:
        ex = await DataService.get_category(categoryId)
        if not ex:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category not found")
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Category with that name already exists in this industry")
    return _to_out(updated)

@router.delete("/{categoryId}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_category(categoryId: str, _admin: str = Depends(require_admin)):
    row = await DataService.get_category(categoryId)
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Category not found")
    if row.get("is_system"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="System categories cannot be deleted (deactivate instead)")
    ok = await DataService.delete_category(categoryId)
    if not ok:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Cannot delete: still has subcategories or receipts")

@router.get("/user-default", response_model=dict)
async def get_default_industry(user_id: str = Depends(get_current_user_id)):
    ind = await DataService.get_user_default_industry(user_id)
    return {"industry_id": ind}

@router.put("/user-default", response_model=dict)
async def set_default_industry(body: dict, user_id: str = Depends(get_current_user_id)):
    iid = body.get("industry_id")
    ok = await DataService.set_user_default_industry(user_id, iid)
    if not ok:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid industry")
    return {"industry_id": iid}
