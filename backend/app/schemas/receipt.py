"""
Pydantic models for receipt data.

These define the request/response schemas for all receipt operations.
"""

from pydantic import BaseModel, Field
from typing import Optional, List, Any
from datetime import datetime
from enum import Enum


class ReceiptStatus(str, Enum):
    """Receipt processing status"""
    PROCESSED = "processed"
    NEEDS_REVIEW = "needs_review"


class ReceiptItemBase(BaseModel):
    """Base receipt item model"""
    name: str = Field(..., min_length=1, description="Item name")
    quantity: float = Field(..., gt=0, description="Quantity purchased")
    price: str = Field(..., description="Price per unit")
    tax: Optional[str] = Field(None, description="Tax on item")
    isZeroRated: Optional[bool] = Field(False, description="Is item zero-rated")
    discount: Optional[str] = Field(None, description="Discount percentage (e.g. '10' for 10% off)")


class ReceiptItemCreate(ReceiptItemBase):
    """Item creation schema"""
    pass


class ReceiptItem(ReceiptItemBase):
    """Item response schema"""
    pass


class ReceiptBase(BaseModel):
    """Base receipt model with common fields"""
    supplier: str = Field(..., min_length=1, description="Supplier/store name")
    totalAmount: str = Field(..., description="Total amount including tax")
    taxAmount: Optional[str] = Field(None, description="Tax amount")
    receiptDate: str = Field(..., description="Receipt date (MM/DD/YYYY format)")
    category: Optional[str] = Field(None, description="Expense category")
    invoiceNumber: Optional[str] = Field(None, description="Invoice/receipt number")
    kraPin: Optional[str] = Field(None, description="Seller KRA PIN (supplier PIN)")
    buyerKraPin: Optional[str] = Field(None, description="Buyer KRA PIN (your PIN)")
    cuInvoice: Optional[str] = Field(None, description="CU invoice number (KRA-issued)")
    batchTitle: Optional[str] = Field(None, description="Batch/transaction title")
    items: List[ReceiptItemCreate] = Field(default_factory=list, description="Receipt items")


class ReceiptCreate(ReceiptBase):
    """Receipt creation schema"""
    imageUrl: Optional[str] = Field(None, description="Image URL (set by backend)")
    status: Optional[ReceiptStatus] = Field(default=ReceiptStatus.PROCESSED)


class ReceiptUpdate(BaseModel):
    """Partial receipt update schema"""
    supplier: Optional[str] = None
    totalAmount: Optional[str] = None
    taxAmount: Optional[str] = None
    receiptDate: Optional[str] = None
    category: Optional[str] = None
    invoiceNumber: Optional[str] = None
    kraPin: Optional[str] = None
    buyerKraPin: Optional[str] = None
    cuInvoice: Optional[str] = None
    batchTitle: Optional[str] = None
    status: Optional[ReceiptStatus] = None
    items: Optional[List[ReceiptItemCreate]] = None


class Receipt(ReceiptBase):
    """Complete receipt response schema"""
    id: str = Field(..., description="Receipt ID")
    userId: str = Field(..., description="User who owns this receipt")
    status: ReceiptStatus = Field(default=ReceiptStatus.PROCESSED)
    imageUrl: Optional[str] = Field(None, description="Image URL in storage")
    thumbnailUrl: Optional[str] = Field(None, description="Thumbnail image URL for fast preview")
    createdAt: datetime = Field(...)
    updatedAt: Optional[datetime] = Field(None)
    scannedAt: Optional[datetime] = Field(None, description="Time when the receipt was scanned/uploaded")

    class Config:
        from_attributes = True


class ReceiptList(BaseModel):
    """List of receipts with pagination"""
    items: List[Receipt]
    total: int
    skip: int
    limit: int


class ReceiptGroup(BaseModel):
    """Summary of a group of receipts (by batchTitle)."""
    batchTitle: str
    count: int
    thumbnailUrl: Optional[str] = None
    totalAmount: float = 0.0
    latestDate: Optional[str] = None
    firstSupplier: Optional[str] = None


class ReceiptGroupList(BaseModel):
    """List of receipt groups."""
    groups: List[ReceiptGroup]


class DuplicateCheckRequest(BaseModel):
    """Request to check for duplicate receipts."""
    supplier: Optional[str] = None
    totalAmount: Optional[str] = None
    receiptDate: Optional[str] = None
    invoiceNumber: Optional[str] = None
    excludeId: Optional[str] = Field(None, description="Receipt ID to exclude (for updates)")


class DuplicateMatch(BaseModel):
    """A potential duplicate receipt."""
    id: str
    supplier: str
    totalAmount: str
    receiptDate: str
    invoiceNumber: Optional[str] = None
    confidence: str  # high, medium


class DuplicateCheckResponse(BaseModel):
    """Response from duplicate check."""
    is_duplicate: bool
    matches: List[DuplicateMatch]


class AuditAction(str, Enum):
    CREATED = "created"
    UPDATED = "updated"
    DELETED = "deleted"


class AuditFieldChange(BaseModel):
    field: str
    old_value: Optional[Any] = None
    new_value: Optional[Any] = None


class AuditEntry(BaseModel):
    id: str
    receipt_id: str
    action: AuditAction
    changed_by: str
    timestamp: datetime
    changes: List[AuditFieldChange] = []


class AuditList(BaseModel):
    items: List[AuditEntry]
    total: int


class SpendingSummaryRequest(BaseModel):
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    category: Optional[str] = None


class CategoryBreakdown(BaseModel):
    category: str
    total: float
    count: int
    percentage: float


class SupplierBreakdown(BaseModel):
    supplier: str
    total: float
    count: int


class MonthlyTrend(BaseModel):
    month: str
    total: float
    count: int


class SpendingSummaryResponse(BaseModel):
    total_spent: float
    total_receipts: int
    total_items: int
    avg_per_receipt: float
    category_breakdown: List[CategoryBreakdown]
    top_suppliers: List[SupplierBreakdown]
    monthly_trend: List[MonthlyTrend]
    ai_summary: Optional[str] = None
