"""
Pydantic models for the admin-managed receipt locations reference table.

Locations are global reference data (not tenant-scoped): the admin curates
the list, every user picks a location for their receipts. A location is a
manual attribute — never produced by AI extraction — and is required before
a receipt can be confirmed as fully processed.
"""

from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime


class LocationBase(BaseModel):
    """Base location model."""
    name: str = Field(..., min_length=1, max_length=120, description="Location name")


class LocationCreate(LocationBase):
    """Location creation schema."""
    pass


class LocationUpdate(BaseModel):
    """Partial location update schema."""
    name: Optional[str] = Field(None, min_length=1, max_length=120, description="Location name")
    is_active: Optional[bool] = Field(None, description="Whether the location may be picked for new receipts")


class LocationOut(BaseModel):
    """Complete location response schema."""
    id: str = Field(..., description="Location ID")
    name: str = Field(..., description="Location name")
    is_active: bool = Field(True, description="Whether the location may be picked")
    created_by: Optional[str] = Field(None, description="Admin uid who created the location")
    created_at: datetime = Field(...)
    updated_at: Optional[datetime] = Field(None)


class LocationList(BaseModel):
    """List of locations."""
    items: list[LocationOut]
    total: int