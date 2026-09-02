"""
Entry type reference data endpoints.

Entry types are admin-curated global reference data. Any authenticated user may
list the active types (for the receipt form dropdown); creating, editing,
and deleting is admin-only. Default is "expense" (counts toward totals).
"""

from fastapi import APIRouter, Depends, HTTPException, status

from app.core.security import get_current_user_id
from app.api.auth import require_admin
from app.schemas.entry_type import (
    EntryTypeCreate,
    EntryTypeUpdate,
    EntryTypeOut,
    EntryTypeList,
)
from app.services.data_adapter import DataService

router = APIRouter(prefix="/entry-types", tags=["entry-types"])


def _to_out(row: dict) -> EntryTypeOut:
    return EntryTypeOut(
        id=str(row["id"]),
        name=row["name"],
        label=row.get("label") or row["name"],
        is_active=bool(row["is_active"]),
        is_system=bool(row.get("is_system", False)),
        created_by=row.get("created_by"),
        created_at=row["created_at"],
        updated_at=row.get("updated_at"),
    )


@router.get("", response_model=EntryTypeList, summary="List pickable entry types")
async def list_entry_types(_: str = Depends(get_current_user_id)):
    """List active entry types every user may choose for a receipt."""
    items = await DataService.list_entry_types(active_only=True)
    return EntryTypeList(items=[_to_out(r) for r in items], total=len(items))


@router.get("/all", response_model=EntryTypeList, summary="List all entry types (admin)")
async def list_all_entry_types(_admin: str = Depends(require_admin)):
    items = await DataService.list_entry_types(active_only=False)
    return EntryTypeList(items=[_to_out(r) for r in items], total=len(items))


@router.post(
    "",
    response_model=EntryTypeOut,
    status_code=status.HTTP_201_CREATED,
    summary="Create an entry type (admin only)",
)
async def create_entry_type(
    body: EntryTypeCreate,
    admin_uid: str = Depends(require_admin),
):
    row = await DataService.create_entry_type(body.name, body.label, created_by=admin_uid)
    if not row:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An entry type with that name already exists",
        )
    return _to_out(row)


@router.put(
    "/{entryTypeId}",
    response_model=EntryTypeOut,
    summary="Update an entry type (admin only)",
)
async def update_entry_type(
    entryTypeId: str,
    body: EntryTypeUpdate,
    _admin_uid: str = Depends(require_admin),
):
    updated = await DataService.update_entry_type(
        entryTypeId,
        body.model_dump(exclude_unset=True),
    )
    if not updated:
        existing = await DataService.get_entry_type(entryTypeId)
        if not existing:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Entry type not found",
            )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="An entry type with that name already exists",
        )
    return _to_out(updated)


@router.delete(
    "/{entryTypeId}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete an entry type (admin only)",
)
async def delete_entry_type(
    entryTypeId: str,
    _admin_uid: str = Depends(require_admin),
):
    row = await DataService.get_entry_type(entryTypeId)
    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Entry type not found",
        )
    if row.get("is_system"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="System entry types cannot be deleted (deactivate instead)",
        )
    deleted = await DataService.delete_entry_type(entryTypeId)
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Entry type not found",
        )
