"""
Pydantic models for the admin-managed entry types reference table.

Entry types are global reference data (not tenant-scoped): the admin curates
the list, every user picks a type for their receipts. The default "expense"
counts toward totals; other types (quotation/proforma etc) are retained but
excluded from totals/exports. Admins can add custom types.
"""

from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime


class EntryTypeBase(BaseModel):
    """Base entry type model."""
    name: str = Field(..., min_length=1, max_length=80, description="Entry type name")
    label: Optional[str] = Field(None, min_length=1, max_length=80, description="Display label (defaults to name)")


class EntryTypeCreate(EntryTypeBase):
    """Entry type creation schema."""
    pass


class EntryTypeUpdate(BaseModel):
    """Partial entry type update schema."""
    name: Optional[str] = Field(None, min_length=1, max_length=80, description="Entry type value (lowercase, no spaces)")
    label: Optional[str] = Field(None, min_length=1, max_length=80, description="Display label")
    is_active: Optional[bool] = Field(None, description="Whether the type may be picked for new receipts")


class EntryTypeOut(BaseModel):
    """Complete entry type response schema."""
    id: str = Field(..., description="Entry type ID")
    name: str = Field(..., description="Entry type value")
    label: str = Field(..., description="Display label")
    is_active: bool = Field(True, description="Whether the type may be picked")
    is_system: bool = Field(False, description="System default (cannot delete, only deactivate)")
    created_by: Optional[str] = Field(None, description="Admin uid who created the type")
    created_at: datetime = Field(...)
    updated_at: Optional[datetime] = Field(None)


class EntryTypeList(BaseModel):
    """List of entry types."""
    items: list[EntryTypeOut]
    total: int
