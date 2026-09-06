from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime

class CategoryBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=80)
    label: Optional[str] = Field(None, min_length=1, max_length=80)
    parent_id: Optional[str] = Field(None, description="Optional subcategory parent")

class CategoryCreate(CategoryBase):
    industry_id: str = Field(..., description="Industry id")

class CategoryUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=80)
    label: Optional[str] = Field(None, min_length=1, max_length=80)
    parent_id: Optional[str] = None
    industry_id: Optional[str] = None
    is_active: Optional[bool] = None

class CategoryOut(BaseModel):
    id: str
    industry_id: str
    name: str
    label: str
    parent_id: Optional[str] = None
    is_active: bool
    is_system: bool
    sort_order: int
    created_by: Optional[str] = None
    created_at: datetime
    updated_at: Optional[datetime] = None

class CategoryList(BaseModel):
    items: list[CategoryOut]
    total: int
