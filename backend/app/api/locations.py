"""
Location reference data endpoints.

Locations are admin-curated global reference data. Any authenticated user may
list the active locations (for the receipt form dropdown); creating, editing,
and deleting is admin-only.

A location is a manual receipt attribute — never AI-extracted. It is NOT
required to submit for approval, but every receipt finalized as `processed`
must carry one (enforced by the workflow layer).
"""

from fastapi import APIRouter, Depends, HTTPException, status

from app.core.security import get_current_user_id
from app.api.auth import require_admin
from app.schemas.location import (
    LocationCreate,
    LocationUpdate,
    LocationOut,
    LocationList,
)
from app.services.data_adapter import DataService

router = APIRouter(prefix="/locations", tags=["locations"])


def _to_out(loc: dict) -> LocationOut:
    return LocationOut(
        id=str(loc["id"]),
        name=loc["name"],
        is_active=bool(loc["is_active"]),
        created_by=loc.get("created_by"),
        created_at=loc["created_at"],
        updated_at=loc.get("updated_at"),
    )


@router.get("", response_model=LocationList, summary="List pickable locations")
async def list_locations(_: str = Depends(get_current_user_id)):
    """List active locations every user may choose for a receipt."""
    items = await DataService.list_locations(active_only=True)
    return LocationList(items=[_to_out(l) for l in items], total=len(items))


@router.post(
    "",
    response_model=LocationOut,
    status_code=status.HTTP_201_CREATED,
    summary="Create a location (admin only)",
)
async def create_location(
    body: LocationCreate,
    admin_uid: str = Depends(require_admin),
):
    """Create a new location in the shared list (admin only)."""
    loc = await DataService.create_location(body.name, created_by=admin_uid)
    if not loc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A location with that name already exists",
        )
    return _to_out(loc)


@router.put(
    "/{locationId}",
    response_model=LocationOut,
    summary="Update a location (admin only)",
)
async def update_location(
    locationId: str,
    body: LocationUpdate,
    _admin_uid: str = Depends(require_admin),
):
    """Rename or active/deactivate a location (admin only)."""
    updated = await DataService.update_location(
        locationId,
        body.model_dump(exclude_unset=True),
    )
    if not updated:
        existing = await DataService.get_location(locationId)
        if not existing:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Location not found",
            )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A location with that name already exists",
        )
    return _to_out(updated)


@router.delete(
    "/{locationId}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a location (admin only)",
)
async def delete_location(
    locationId: str,
    _admin_uid: str = Depends(require_admin),
):
    """Remove a location from the shared list (admin only)."""
    deleted = await DataService.delete_location(locationId)
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Location not found",
        )