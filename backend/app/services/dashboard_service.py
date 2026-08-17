"""
Dashboard analytics service.

Computes aggregations from Firestore receipt data.  Firestore has no
server-side aggregation, so we stream all documents and reduce in-process.
The same approach is used by the existing summary endpoint; this service
packages the logic into reusable, focused methods.
"""

import logging
from datetime import datetime
from typing import Optional, List, Dict, Any
from collections import defaultdict

from app.services.data_adapter import DataService
from app.services.gemini import generate_ai_summary

logger = logging.getLogger(__name__)

MONTH_NAMES = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]


# ── helpers ───────────────────────────────────────────────────────────────────

def _parse_date_mmddyyyy(s: str) -> Optional[str]:
    """Normalise MM/DD/YYYY → YYYY-MM-DD (comparable string)."""
    try:
        parts = s.split("/")
        if len(parts) == 3:
            return f"{parts[2]}-{parts[0].zfill(2)}-{parts[1].zfill(2)}"
        return s
    except Exception:
        return s


def _parse_amount(val: Any) -> float:
    """Safely parse a numeric field to float."""
    try:
        return float(val or 0)
    except (ValueError, TypeError):
        return 0.0


def _extract_month(date_str: str) -> str:
    """Extract 'YYYY-MM' from a raw receipt date string (MM/DD/YYYY or YYYY-MM-DD)."""
    if not date_str:
        return "Unknown"
    norm = _parse_date_mmddyyyy(date_str)
    if norm and len(norm) >= 7:
        return norm[:7]
    return "Unknown"


def _format_month_label(ym: str) -> str:
    """Convert 'YYYY-MM' → 'Mon YYYY'."""
    try:
        y, m = ym.split("-")
        idx = int(m) - 1
        return f"{MONTH_NAMES[idx]} {y}" if 0 <= idx < 12 else ym
    except Exception:
        return ym


# ── service class ─────────────────────────────────────────────────────────────

class DashboardService:
    """Compute dashboard analytics from user receipts."""

    @staticmethod
    async def _fetch_receipts(
        user_id: str,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Fetch all receipts for a user, optionally filtered by date range."""
        receipts, _ = await DataService.list_receipts(
            user_id, skip=0, limit=5000,
        )

        if not date_from and not date_to:
            return receipts

        filtered: List[Dict[str, Any]] = []
        for r in receipts:
            norm = _parse_date_mmddyyyy(r.get("receiptDate") or "")
            if date_from and norm < date_from:
                continue
            if date_to and norm > date_to:
                continue
            filtered.append(r)

        return filtered

    # ── overview ──────────────────────────────────────────────────────────

    @staticmethod
    async def get_overview(
        user_id: str,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
    ) -> Dict[str, Any]:
        receipts = await DashboardService._fetch_receipts(user_id, date_from, date_to)

        total_spent = 0.0
        subtotal = 0.0
        tax_total = 0.0
        total_items = 0
        processed = 0
        review = 0
        largest = 0.0
        suppliers = set()
        categories = set()
        batches = set()

        for r in receipts:
            total_spent += _parse_amount(r.get("totalAmount"))
            largest = max(largest, _parse_amount(r.get("totalAmount")))

            if r.get("status") == "processed":
                processed += 1
            elif r.get("status") in ("needs_review", "pending_approval"):
                review += 1

            sup = (r.get("supplier") or "").strip()
            if sup and sup.lower() != "unknown":
                suppliers.add(sup)

            cat = (r.get("category") or "").strip()
            if cat and cat.lower() not in ("uncategorized", "other"):
                categories.add(cat)

            batch = (r.get("batchTitle") or "").strip()
            if batch:
                batches.add(batch)

            items = r.get("items") or []
            total_items += len(items)

            for item in items:
                price = _parse_amount(item.get("price"))
                qty = float(item.get("quantity", 0) or 0)
                tax = _parse_amount(item.get("tax"))
                subtotal += price * qty
                tax_total += tax * qty

        n = len(receipts)
        return {
            "total_spent": round(total_spent, 2),
            "total_receipts": n,
            "total_items": total_items,
            "avg_per_receipt": round(total_spent / n, 2) if n else 0.0,
            "processed_count": processed,
            "review_count": review,
            "batch_count": len(batches),
            "supplier_count": len(suppliers),
            "category_count": len(categories),
            "subtotal": round(subtotal, 2),
            "tax_total": round(tax_total, 2),
            "largest_receipt": round(largest, 2) if largest else None,
            "avg_items_per_receipt": round(total_items / n, 2) if n else 0.0,
            "batch_titles": sorted(batches),
            "date_range_start": date_from,
            "date_range_end": date_to,
        }

    # ── trends ─────────────────────────────────────────────────────────────

    @staticmethod
    async def get_trends(
        user_id: str,
        months: int = 12,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
    ) -> Dict[str, Any]:
        receipts = await DashboardService._fetch_receipts(user_id, date_from, date_to)

        monthly: Dict[str, Dict[str, Any]] = defaultdict(
            lambda: {"total": 0.0, "count": 0}
        )

        for r in receipts:
            ym = _extract_month(r.get("receiptDate") or "")
            if ym == "Unknown":
                continue
            amount = _parse_amount(r.get("totalAmount"))
            monthly[ym]["total"] += amount
            monthly[ym]["count"] += 1

        # Build sorted trend points
        sorted_months = sorted(monthly.keys())
        if months and len(sorted_months) > months:
            sorted_months = sorted_months[-months:]

        points = []
        for ym in sorted_months:
            d = monthly[ym]
            cnt = d["count"]
            points.append({
                "month": ym,
                "month_label": _format_month_label(ym),
                "total": round(d["total"], 2),
                "count": cnt,
                "avg_per_receipt": round(d["total"] / cnt, 2) if cnt else 0.0,
            })

        # Derived stats
        totals = [p["total"] for p in points]
        period_total = round(sum(totals), 2) if totals else 0.0
        period_avg = round(period_total / len(totals), 2) if totals else 0.0

        best = max(points, key=lambda p: p["total"]) if points else None
        worst = min(points, key=lambda p: p["total"]) if points else None

        # Month-over-month average change
        mom_change = None
        if len(totals) >= 2:
            deltas = []
            for i in range(1, len(totals)):
                if totals[i - 1] > 0:
                    deltas.append((totals[i] - totals[i - 1]) / totals[i - 1] * 100)
            if deltas:
                mom_change = round(sum(deltas) / len(deltas), 1)

        return {
            "monthly": points,
            "period_total": period_total,
            "period_avg_monthly": period_avg,
            "best_month": best,
            "worst_month": worst,
            "month_over_month_change": mom_change,
        }

    # ── breakdown ──────────────────────────────────────────────────────────

    @staticmethod
    async def get_breakdown(
        user_id: str,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
    ) -> Dict[str, Any]:
        receipts = await DashboardService._fetch_receipts(user_id, date_from, date_to)

        cat_totals: Dict[str, float] = defaultdict(float)
        cat_counts: Dict[str, int] = defaultdict(int)
        sup_totals: Dict[str, float] = defaultdict(float)
        sup_counts: Dict[str, int] = defaultdict(int)

        for r in receipts:
            amount = _parse_amount(r.get("totalAmount"))
            cat = (r.get("category") or "Uncategorized").strip() or "Uncategorized"
            sup = (r.get("supplier") or "Unknown").strip() or "Unknown"

            cat_totals[cat] += amount
            cat_counts[cat] += 1
            sup_totals[sup] += amount
            sup_counts[sup] += 1

        grand_total = sum(cat_totals.values()) or 1.0  # avoid div-by-zero

        def _cat_slice(cat: str, tot: float) -> Dict[str, Any]:
            cnt = cat_counts[cat]
            return {
                "category": cat,
                "total": round(tot, 2),
                "count": cnt,
                "percentage": round(tot / grand_total * 100, 1),
                "avg_per_receipt": round(tot / cnt, 2) if cnt else 0.0,
            }

        def _sup_slice(sup: str, tot: float) -> Dict[str, Any]:
            cnt = sup_counts[sup]
            return {
                "supplier": sup,
                "total": round(tot, 2),
                "count": cnt,
                "percentage": round(tot / grand_total * 100, 1),
                "avg_per_receipt": round(tot / cnt, 2) if cnt else 0.0,
            }

        categories = sorted(
            [_cat_slice(c, t) for c, t in cat_totals.items()],
            key=lambda x: -x["total"],
        )
        suppliers = sorted(
            [_sup_slice(s, t) for s, t in sup_totals.items()],
            key=lambda x: -x["total"],
        )

        return {
            "categories": categories,
            "suppliers": suppliers[:10],
            "top_category": categories[0] if categories else None,
            "top_supplier": suppliers[0] if suppliers else None,
        }

    # ── insights ───────────────────────────────────────────────────────────

    @staticmethod
    async def get_insights(
        user_id: str,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Generate dashboard insights — a mix of rule-based heuristics and an
        optional AI summary.
        """
        receipts = await DashboardService._fetch_receipts(user_id, date_from, date_to)

        insights: List[Dict[str, str]] = []
        n = len(receipts)
        if n == 0:
            return {"insights": [], "ai_summary": None}

        # ── rule-based insights ──────────────────────────────────────────

        # Spending concentration
        cat_totals: Dict[str, float] = defaultdict(float)
        sup_totals: Dict[str, float] = defaultdict(float)
        statuses: Dict[str, int] = defaultdict(int)

        for r in receipts:
            amount = _parse_amount(r.get("totalAmount"))
            cat_totals[r.get("category") or "Uncategorized"] += amount
            sup_totals[r.get("supplier") or "Unknown"] += amount
            statuses[r.get("status") or "needs_review"] += 1

        total = sum(cat_totals.values()) or 1
        top_cat = max(cat_totals, key=cat_totals.get) if cat_totals else None
        top_cat_pct = (cat_totals[top_cat] / total * 100) if top_cat else 0

        top_sup = max(sup_totals, key=sup_totals.get) if sup_totals else None
        top_sup_pct = (sup_totals[top_sup] / total * 100) if top_sup else 0

        review_pct = (statuses.get("needs_review", 0) / n * 100) if n else 0

        if top_cat_pct >= 50:
            insights.append({
                "type": "spending_pattern",
                "title": f"Top category dominates",
                "description": f"'{top_cat}' accounts for {top_cat_pct:.0f}% of your spending. Consider reviewing for budgeting.",
                "importance": "high",
            })

        if top_sup_pct >= 40:
            insights.append({
                "type": "spending_pattern",
                "title": f"Supplier concentration",
                "description": f"'{top_sup}' receives {top_sup_pct:.0f}% of your spend. You may want to diversify or negotiate.",
                "importance": "medium",
            })

        if review_pct > 30:
            insights.append({
                "type": "tip",
                "title": f"{review_pct:.0f}% receipts need review",
                "description": "Many receipts are unprocessed. Review them to get better analytics.",
                "importance": "high" if review_pct > 50 else "medium",
            })

        # Detect if there are very few categories
        unique_cats = len(cat_totals)
        if unique_cats <= 2 and n >= 5:
            insights.append({
                "type": "tip",
                "title": "Try categorising your receipts",
                "description": f"You only have {unique_cats} categor{'y' if unique_cats == 1 else 'ies'}. Better categories unlock better insights.",
                "importance": "medium",
            })

        # Average receipt value insight
        avg = total / n
        if avg > 10000:
            insights.append({
                "type": "trend",
                "title": "High average receipt value",
                "description": f"Your average receipt is KES {avg:,.0f}. This is relatively high — look for savings opportunities.",
                "importance": "medium",
            })

        # Supplier count insight
        unique_sups = len(sup_totals)
        if unique_sups >= 10:
            insights.append({
                "type": "trend",
                "title": "Diverse supplier base",
                "description": f"You've shopped at {unique_sups} different suppliers. Good diversification.",
                "importance": "low",
            })

        # ── AI summary (best-effort, disabled by default) ─────────────────

        ai_summary = None
        if n >= 3:
            from app.services.app_settings_service import get_ai_summary_enabled
            if await get_ai_summary_enabled():
                try:
                    summary_input = "\n".join(
                        f"{r.get('receiptDate','')}|{r.get('supplier','')}|{r.get('totalAmount',0)}|{r.get('category','Other')}"
                        for r in receipts[:200]
                    )
                    ai_summary = await generate_ai_summary(summary_input)
                except Exception:
                    logger.warning("AI summary generation failed", exc_info=True)

        return {"insights": insights, "ai_summary": ai_summary}
