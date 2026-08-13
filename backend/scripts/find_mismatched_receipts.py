"""
List receipts whose summed line-item totals don't reconcile with the
stored receipt total. Use to spot Gemini extraction errors that need
manual correction in the UI.

Item-level formula: qty * (price + tax) * (1 - discount/100)
A mismatch usually means: misread unit price (often the receipt total
got captured as the unit price), wrong quantity, or missing line items.

Usage (from repo root, while docker compose is up):
    docker compose exec backend python scripts/find_mismatched_receipts.py
    docker compose exec backend python scripts/find_mismatched_receipts.py 2026-01-01 2026-07-01
    docker compose exec backend python scripts/find_mismatched_receipts.py --tolerance 5
"""

import argparse
import asyncio
import os
import sys
from datetime import date

import asyncpg


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("date_from", nargs="?", default="2026-01-01",
                        help="Inclusive lower bound (YYYY-MM-DD). Default: 2026-01-01")
    parser.add_argument("date_to", nargs="?", default="2026-07-01",
                        help="Exclusive upper bound (YYYY-MM-DD). Default: 2026-07-01")
    parser.add_argument("--tolerance", type=float, default=1.0,
                        help="Absolute KSh tolerance below which a receipt is considered reconciled (default: 1.0)")
    args = parser.parse_args()

    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        print("DATABASE_URL not set", file=sys.stderr)
        sys.exit(1)

    date_from = date.fromisoformat(args.date_from)
    date_to = date.fromisoformat(args.date_to)

    conn = await asyncpg.connect(dsn)
    try:
        rows = await conn.fetch(
            """
            WITH per_receipt AS (
                SELECT
                    r.id,
                    r.receipt_date,
                    r.supplier,
                    r.invoice_number,
                    r.total_amount AS receipt_total,
                    r.tax_amount,
                    COALESCE((
                        SELECT SUM(li.quantity * (li.price + COALESCE(li.tax, 0))
                                   * (1 - COALESCE(li.discount, 0) / 100.0))
                        FROM line_items li
                        WHERE li.receipt_id = r.id
                    ), 0) AS items_total,
                    (SELECT COUNT(*) FROM line_items li WHERE li.receipt_id = r.id) AS n_items
                FROM receipts r
                WHERE r.receipt_date >= $1
                  AND r.receipt_date <  $2
            )
            SELECT id, receipt_date, supplier, invoice_number, receipt_total,
                   tax_amount, items_total, n_items,
                   (items_total - receipt_total) AS variance
            FROM per_receipt
            WHERE ABS(items_total - receipt_total) >= $3
            ORDER BY ABS(items_total - receipt_total) DESC
            """,
            date_from, date_to, args.tolerance,
        )
    finally:
        await conn.close()

    if not rows:
        print(f"All receipts between {args.date_from} and {args.date_to} reconcile within {args.tolerance}.")
        return

    print(f"Mismatched receipts ({args.date_from} → {args.date_to}, tolerance {args.tolerance}):")
    print(f"Found {len(rows)} receipt(s). Sorted by absolute variance (largest first).\n")
    print(f"{'Date':<11} {'Receipt ID':<38} {'Supplier':<32} "
          f"{'Invoice':<14} {'N':>3} {'Receipt':>13} {'Items':>13} {'Variance':>13}")
    print("-" * 152)
    total_variance = 0.0
    for r in rows:
        supplier = (r["supplier"] or "")[:32]
        invoice = (r["invoice_number"] or "")[:14]
        variance = float(r["variance"])
        total_variance += variance
        print(f"{str(r['receipt_date']):<11} {r['id']:<38} {supplier:<32} "
              f"{invoice:<14} {r['n_items']:>3} "
              f"{float(r['receipt_total']):>13,.2f} "
              f"{float(r['items_total']):>13,.2f} "
              f"{variance:>+13,.2f}")
    print("-" * 152)
    print(f"{'Net variance':>140}: {total_variance:>+13,.2f}")


if __name__ == "__main__":
    asyncio.run(main())
