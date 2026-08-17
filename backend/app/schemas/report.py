from enum import Enum
from typing import Dict, Optional

from pydantic import BaseModel


class ReportFormat(str, Enum):
    CSV = "csv"
    XLSX = "xlsx"
    PDF = "pdf"
    JSON = "json"


class ReportRunRequest(BaseModel):
    format: ReportFormat = ReportFormat.CSV
    dateFrom: Optional[str] = None
    dateTo: Optional[str] = None
    includeSensitive: bool = False
    filters: Dict[str, str] = {}