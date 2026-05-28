from pydantic import BaseModel
from typing import Optional, List
from enum import Enum


class ExportFormat(str, Enum):
    XLSX = "xlsx"
    PDF = "pdf"
    CSV = "csv"


class ReportType(str, Enum):
    DETAILED = "detailed"
    CATEGORY = "category"
    SUPPLIER = "supplier"
    MONTHLY = "monthly"
    TAX = "tax"
    PIVOT = "pivot"
    RECEIPTS = "receipts"


class PivotField(str, Enum):
    MONTH = "month"
    SUPPLIER = "supplier"
    CATEGORY = "category"


class PivotValue(str, Enum):
    TOTAL_AMOUNT = "totalAmount"
    COUNT = "count"


class ExportPivotConfig(BaseModel):
    rowField: PivotField
    colField: PivotField
    valueField: PivotValue


class ExportRequest(BaseModel):
    format: ExportFormat
    reportType: ReportType
    date_from: Optional[str] = None
    date_to: Optional[str] = None
    category: Optional[str] = None
    pivotConfig: Optional[ExportPivotConfig] = None
    columns: Optional[List[str]] = None
