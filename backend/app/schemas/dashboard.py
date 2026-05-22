"""
Dashboard schemas.

Purpose-built models for the dashboard analytics API.
"""

from typing import Optional, List
from pydantic import BaseModel, Field


# ── Overview ──────────────────────────────────────────────────────────────────

class DashboardOverview(BaseModel):
    """KPI-level summary for the dashboard hero cards."""
    total_spent: float
    total_receipts: int
    total_items: int
    avg_per_receipt: float
    processed_count: int
    review_count: int
    batch_count: int
    supplier_count: int
    category_count: int
    subtotal: float
    tax_total: float
    largest_receipt: Optional[float] = None
    avg_items_per_receipt: float
    batch_titles: List[str] = []
    date_range_start: Optional[str] = None
    date_range_end: Optional[str] = None


# ── Trends ────────────────────────────────────────────────────────────────────

class TrendPoint(BaseModel):
    """A single month in the trend series."""
    month: str          # "2026-05"
    month_label: str    # "May 2026"
    total: float
    count: int
    avg_per_receipt: float


class DashboardTrends(BaseModel):
    """Monthly spending trend data."""
    monthly: List[TrendPoint]
    period_total: float
    period_avg_monthly: float
    best_month: Optional[TrendPoint] = None
    worst_month: Optional[TrendPoint] = None
    month_over_month_change: Optional[float] = None  # avg MoM % change


# ── Breakdown ─────────────────────────────────────────────────────────────────

class CategorySlice(BaseModel):
    category: str
    total: float
    count: int
    percentage: float
    avg_per_receipt: float


class SupplierSlice(BaseModel):
    supplier: str
    total: float
    count: int
    percentage: float
    avg_per_receipt: float


class DashboardBreakdown(BaseModel):
    """Category + supplier breakdown for charts."""
    categories: List[CategorySlice]
    suppliers: List[SupplierSlice]
    top_category: Optional[CategorySlice] = None
    top_supplier: Optional[SupplierSlice] = None


# ── Insights ──────────────────────────────────────────────────────────────────

class DashboardInsight(BaseModel):
    """A single computed or AI insight."""
    type: str           # "spending_pattern" | "anomaly" | "trend" | "tip"
    title: str
    description: str
    importance: str     # "high" | "medium" | "low"


class DashboardInsights(BaseModel):
    """Collection of insights for the dashboard."""
    insights: List[DashboardInsight] = []
    ai_summary: Optional[str] = None
