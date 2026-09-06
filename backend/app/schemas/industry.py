from pydantic import BaseModel, Field
from typing import Optional
from datetime import datetime

class IndustryBase(BaseModel):
    name: str = Field(..., min_length=1, max_length=80, description="Industry name")
    description: Optional[str] = Field(None, max_length=300, description="Description")

class IndustryCreate(IndustryBase):
    pass

class IndustryUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=80)
    description: Optional[str] = Field(None, max_length=300)
    is_active: Optional[bool] = None

class IndustryOut(BaseModel):
    id: str
    name: str
    description: Optional[str] = None
    is_active: bool
    is_system: bool
    created_by: Optional[str] = None
    created_at: datetime
    updated_at: Optional[datetime] = None

class IndustryList(BaseModel):
    items: list[IndustryOut]
    total: int
