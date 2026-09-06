"""
Dashboard analytics API.

Purpose-built endpoints that return pre-computed analytics for the
dashboard UI.  Each endpoint does one thing and returns a focused payload
so the frontend can fetch them in parallel with fine-grained loading states.

Endpoints
---------
GET  /users/{userId}/dashboard/overview    KPI cards
GET  /users/{userId}/dashboard/trends      Monthly time-series
GET  /users/{userId}/dashboard/breakdown   Category & supplier split
GET  /users/{userId}/dashboard/insights    Rule-based + AI insights
"""

import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.core.security import get_current_user_id
from app.schemas.dashboard import (
    DashboardOverview,
    DashboardTrends,
    DashboardBreakdown,
    DashboardInsights,
    DashboardInsight,
    DashboardYearly,
    TrendPoint,
    YearPoint,
    CategorySlice,
    SupplierSlice,
)
from app.services.dashboard_service import DashboardService

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/users",
    tags=["dashboard"],
)


async def _check_access(user_id: str, current_user_id: str) -> None:
    if user_id == current_user_id:
        return
    from app.services import auth_service
    from app.core.database import set_current_user_id
    user = await auth_service.get_user_by_uid(current_user_id)
    if user and user.get("is_admin"):
        set_current_user_id(user_id)
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Access denied",
    )


# ── GET /overview ─────────────────────────────────────────────────────────────

@router.get(
    "/{userId}/dashboard/years",
    summary="Available years for dashboard",
)
async def dashboard_years(
    userId: str,
    current_user_id: str = Depends(get_current_user_id),
):
    await _check_access(userId, current_user_id)
    try:
        years = await DashboardService.get_years(userId)
        return {"years": years}
    except Exception as e:
        logger.error(f"Dashboard years failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to load years")

@router.get(
    "/{userId}/dashboard/overview",
    response_model=DashboardOverview,
    summary="Dashboard KPI overview",
)
async def dashboard_overview(
    userId: str,
    date_from: Optional[str] = Query(None, description="Start date MM/DD/YYYY"),
    date_to: Optional[str] = Query(None, description="End date MM/DD/YYYY"),
    industry_id: Optional[str] = Query(None, description="Industry filter"),
    include_unreviewed: bool = Query(False, description="Include needs_review in verified totals"),
    current_user_id: str = Depends(get_current_user_id),
):
    await _check_access(userId, current_user_id)
    try:
        data = await DashboardService.get_overview(userId, date_from, date_to, industry_id, include_unreviewed)
        return DashboardOverview(**data)
    except Exception as e:
        logger.error(f"Dashboard overview failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to load dashboard overview")


# ── GET /trends ───────────────────────────────────────────────────────────────

@router.get(
    "/{userId}/dashboard/trends",
    response_model=DashboardTrends,
    summary="Monthly spending trends",
)
async def dashboard_trends(
    userId: str,
    months: int = Query(12, ge=1, le=36, description="Number of months to return"),
    date_from: Optional[str] = Query(None, description="Start date MM/DD/YYYY"),
    date_to: Optional[str] = Query(None, description="End date MM/DD/YYYY"),
    industry_id: Optional[str] = Query(None),
    include_unreviewed: bool = Query(False),
    current_user_id: str = Depends(get_current_user_id),
):
    await _check_access(userId, current_user_id)
    try:
        data = await DashboardService.get_trends(userId, months, date_from, date_to, industry_id, include_unreviewed)
        return DashboardTrends(
            monthly=[TrendPoint(**p) for p in data["monthly"]],
            period_total=data["period_total"],
            period_avg_monthly=data["period_avg_monthly"],
            best_month=TrendPoint(**data["best_month"]) if data["best_month"] else None,
            worst_month=TrendPoint(**data["worst_month"]) if data["worst_month"] else None,
            month_over_month_change=data["month_over_month_change"],
        )
    except Exception as e:
        logger.error(f"Dashboard trends failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to load dashboard trends")


# ── GET /breakdown ────────────────────────────────────────────────────────────

@router.get(
    "/{userId}/dashboard/breakdown",
    response_model=DashboardBreakdown,
    summary="Spending breakdown by category and supplier",
)
async def dashboard_breakdown(
    userId: str,
    date_from: Optional[str] = Query(None, description="Start date MM/DD/YYYY"),
    date_to: Optional[str] = Query(None, description="End date MM/DD/YYYY"),
    industry_id: Optional[str] = Query(None),
    include_unreviewed: bool = Query(False),
    current_user_id: str = Depends(get_current_user_id),
):
    await _check_access(userId, current_user_id)
    try:
        data = await DashboardService.get_breakdown(userId, date_from, date_to, industry_id, include_unreviewed)
        return DashboardBreakdown(
            categories=[CategorySlice(**c) for c in data["categories"]],
            suppliers=[SupplierSlice(**s) for s in data["suppliers"]],
            top_category=CategorySlice(**data["top_category"]) if data["top_category"] else None,
            top_supplier=SupplierSlice(**data["top_supplier"]) if data["top_supplier"] else None,
        )
    except Exception as e:
        logger.error(f"Dashboard breakdown failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to load dashboard breakdown")


# ── GET /yearly ───────────────────────────────────────────────────────────────

@router.get(
    "/{userId}/dashboard/yearly",
    response_model=DashboardYearly,
    summary="Yearly breakdown (last 5 years, ignores year filter)",
)
async def dashboard_yearly(
    userId: str,
    industry_id: Optional[str] = Query(None),
    include_unreviewed: bool = Query(False),
    last_n: int = Query(5, ge=1, le=10),
    current_user_id: str = Depends(get_current_user_id),
):
    await _check_access(userId, current_user_id)
    try:
        data = await DashboardService.get_yearly(userId, industry_id, include_unreviewed, last_n)
        return DashboardYearly(
            yearly=[YearPoint(**p) for p in data["yearly"]],
            period_total=data["period_total"],
        )
    except Exception as e:
        logger.error(f"Dashboard yearly failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to load dashboard yearly")


# ── GET /insights ─────────────────────────────────────────────────────────────

@router.get(
    "/{userId}/dashboard/insights",
    response_model=DashboardInsights,
    summary="Computed and AI insights",
)
async def dashboard_insights(
    userId: str,
    date_from: Optional[str] = Query(None, description="Start date MM/DD/YYYY"),
    date_to: Optional[str] = Query(None, description="End date MM/DD/YYYY"),
    industry_id: Optional[str] = Query(None),
    include_unreviewed: bool = Query(False),
    current_user_id: str = Depends(get_current_user_id),
):
    await _check_access(userId, current_user_id)
    try:
        data = await DashboardService.get_insights(userId, date_from, date_to, industry_id, include_unreviewed)
        return DashboardInsights(
            insights=[DashboardInsight(**i) for i in data["insights"]],
        )
    except Exception as e:
        logger.error(f"Dashboard insights failed: {e}")
        raise HTTPException(status_code=500, detail="Failed to load dashboard insights")
