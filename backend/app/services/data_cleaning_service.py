import logging
from difflib import SequenceMatcher
from typing import Optional, List, Dict, Any, Tuple
from collections import defaultdict
from datetime import datetime

from app.services.firebase_service import FirestoreService, get_db

logger = logging.getLogger(__name__)

SIMILARITY_THRESHOLD = 0.80
DUPLICATE_THRESHOLD = 0.85

PROPAGATABLE_FIELDS = ["kraPin", "category"]


# ─── Fuzzy helpers ────────────────────────────────────────────────────────

def similarity(a: str, b: str) -> float:
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a.lower().strip(), b.lower().strip()).ratio()


def normalize_supplier(name: str) -> str:
    """Strip common suffixes/prefixes for better matching."""
    n = name.lower().strip()
    for suffix in [" inc", " ltd", " limited", " corporation", " corp", " llc", " co", " store", " stores"]:
        if n.endswith(suffix):
            n = n[:-len(suffix)]
    for prefix in ["the ", "m/s ", "m/s. "]:
        if n.startswith(prefix):
            n = n[len(prefix):]
    return n.strip()


# ─── Receipt helpers ──────────────────────────────────────────────────────

def _to_float(v: Any) -> float:
    try:
        return float(str(v).replace(",", "").replace("KES", "").strip())
    except (ValueError, AttributeError):
        return 0.0


# ═══════════════════════════════════════════════════════════════════════════
# Supplier merge suggestions
# ═══════════════════════════════════════════════════════════════════════════

def suggest_supplier_merges(receipts: List[dict]) -> List[dict]:
    """Find supplier names that are similar but not identical, group into clusters."""
    # Collect unique supplier names
    supplier_map: Dict[str, List[str]] = defaultdict(list)
    for r in receipts:
        name = (r.get("supplier") or "Unknown").strip()
        if name and name != "Unknown":
            supplier_map[name].append(r["id"])

    unique_names = list(supplier_map.keys())
    merged = set()
    clusters: List[dict] = []

    for i, name_a in enumerate(unique_names):
        if name_a in merged:
            continue
        norm_a = normalize_supplier(name_a)
        cluster = {
            "canonical": name_a,
            "variants": [name_a],
            "receipt_ids": list(supplier_map[name_a]),
            "scores": [1.0],
        }
        for j in range(i + 1, len(unique_names)):
            name_b = unique_names[j]
            if name_b in merged:
                continue
            norm_b = normalize_supplier(name_b)
            sim = similarity(norm_a, norm_b)
            if sim >= SIMILARITY_THRESHOLD and norm_a != norm_b:
                cluster["variants"].append(name_b)
                cluster["receipt_ids"].extend(supplier_map[name_b])
                cluster["scores"].append(round(sim, 3))
                merged.add(name_b)

        if len(cluster["variants"]) > 1:
            # Sort variants by frequency (most receipts first)
            paired = sorted(
                zip(cluster["variants"], cluster["receipt_ids"], cluster["scores"]),
                key=lambda x: -len(supplier_map.get(x[0], []))
            )
            cluster["canonical"] = paired[0][0]
            cluster["variants"] = [p[0] for p in paired]
            cluster["scores"] = [p[2] for p in paired]
            cluster["receipt_ids"] = [rid for p in paired for rid in (supplier_map.get(p[0]) or [])]
            clusters.append(cluster)
            merged.add(name_a)

    # Sort clusters by total impact (number of receipts)
    clusters.sort(key=lambda c: -len(c["receipt_ids"]))
    return clusters


# ═══════════════════════════════════════════════════════════════════════════
# Field propagation suggestions
# ═══════════════════════════════════════════════════════════════════════════

def suggest_field_propagation(receipts: List[dict]) -> List[dict]:
    """Find fields that can be propagated from receipts that have them to those that don't (same supplier)."""
    suggestions = []

    # Group receipts by normalized supplier
    supplier_groups: Dict[str, List[dict]] = defaultdict(list)
    for r in receipts:
        norm = normalize_supplier(r.get("supplier") or "Unknown")
        supplier_groups[norm].append(r)

    for norm_sup, group in supplier_groups.items():
        for field in PROPAGATABLE_FIELDS:
            # Find receipts with a non-empty value
            source_ids = []
            known_value = None
            target_ids = []

            for r in group:
                val = r.get(field)
                if val and str(val).strip() and str(val).strip() not in ("N/A", ""):
                    if known_value is None:
                        known_value = str(val).strip()
                    # Only use as source if it matches the first known value
                    if str(val).strip() == known_value:
                        source_ids.append(r["id"])
                else:
                    target_ids.append(r["id"])

            if known_value and source_ids and target_ids:
                suggestions.append({
                    "field": field,
                    "value": known_value,
                    "supplier": group[0].get("supplier", "Unknown"),
                    "source_receipts": source_ids,
                    "target_receipts": target_ids,
                })

    # Sort by most targets affected
    suggestions.sort(key=lambda s: -len(s["target_receipts"]))
    return suggestions


# ═══════════════════════════════════════════════════════════════════════════
# Duplicate suggestions
# ═══════════════════════════════════════════════════════════════════════════

def _date_diff_days(d1: str, d2: str) -> Optional[int]:
    """Return absolute difference in days between two MM/DD/YYYY dates, or None if invalid."""
    try:
        from datetime import datetime as dt
        a = dt.strptime(d1, "%m/%d/%Y")
        b = dt.strptime(d2, "%m/%d/%Y")
        return abs((a - b).days)
    except (ValueError, TypeError):
        return None


def suggest_duplicates(receipts: List[dict]) -> List[dict]:
    """Find receipts that are likely duplicates.

    Rules:
    - Same invoice number (both non-empty) → definite duplicate regardless of date.
    - Same date OR adjacent dates + high supplier + high amount match → likely duplicate.
    - Different dates (>1 day apart) with no invoice match → NOT a duplicate
      (recurring purchase, e.g. buying fuel weekly).
    """
    checked = set()
    duplicates = []

    for i, a in enumerate(receipts):
        if a["id"] in checked:
            continue
        a_sup = (a.get("supplier") or "").strip()
        a_amt = _to_float(a.get("totalAmount"))
        a_date = (a.get("receiptDate") or "").strip()
        a_inv = (a.get("invoiceNumber") or "").strip()
        a_items = a.get("items") or []

        pair_group = {"receipts": [a], "keep_id": a["id"], "scores": [1.0]}

        for j in range(i + 1, len(receipts)):
            b = receipts[j]
            if b["id"] in checked:
                continue
            b_sup = (b.get("supplier") or "").strip()
            b_amt = _to_float(b.get("totalAmount"))
            b_date = (b.get("receiptDate") or "").strip()
            b_inv = (b.get("invoiceNumber") or "").strip()
            b_items = b.get("items") or []

            # Rule 1: Same non-empty invoice number → definite duplicate
            if a_inv and b_inv and a_inv == b_inv:
                pair_group["receipts"].append(b)
                pair_group["scores"].append(1.0)
                checked.add(b["id"])
                checked.add(a["id"])
                continue

            # Check date proximity — different dates are likely recurring purchases
            date_diff = _date_diff_days(a_date, b_date)
            if date_diff is not None and date_diff > 1:
                continue  # more than 1 day apart → not a duplicate (recurring)

            # Rule 2: Same/adjacent date + high supplier + high amount
            sup_sim = similarity(a_sup, b_sup)
            amt_sim = 1.0 - min(abs(a_amt - b_amt) / max(a_amt, b_amt, 1), 1.0)
            item_sim = 1.0 if len(a_items) == len(b_items) and len(a_items) > 0 else 0.5

            combined = sup_sim * 0.40 + amt_sim * 0.35 + item_sim * 0.25

            if combined >= DUPLICATE_THRESHOLD:
                pair_group["receipts"].append(b)
                pair_group["scores"].append(round(combined, 3))
                checked.add(b["id"])
                checked.add(a["id"])

        if len(pair_group["receipts"]) > 1:
            def completeness(r):
                score = 0
                for f in ["supplier", "totalAmount", "receiptDate", "invoiceNumber", "kraPin", "category"]:
                    v = r.get(f)
                    if v and str(v).strip() not in ("", "N/A"):
                        score += 1
                items = r.get("items") or []
                score += len(items) * 0.5
                return score

            pair_group["receipts"].sort(key=completeness, reverse=True)
            pair_group["keep_id"] = pair_group["receipts"][0]["id"]
            duplicates.append(pair_group)

    duplicates.sort(key=lambda d: -len(d["receipts"]))
    return duplicates


# ═══════════════════════════════════════════════════════════════════════════
# Summary
# ═══════════════════════════════════════════════════════════════════════════

def generate_all_suggestions(receipts: List[dict]) -> dict:
    return {
        "supplier_merges": suggest_supplier_merges(receipts),
        "field_propagations": suggest_field_propagation(receipts),
        "duplicates": suggest_duplicates(receipts),
    }


# ═══════════════════════════════════════════════════════════════════════════
# Apply actions
# ═══════════════════════════════════════════════════════════════════════════

async def apply_actions(user_id: str, actions: List[dict]) -> dict:
    stats = {"supplier_renames": 0, "fields_filled": 0, "duplicates_removed": 0}

    for action in actions:
        atype = action.get("type")

        if atype == "supplier_merge":
            canonical = action["canonical"]
            for rid in action["receipt_ids"]:
                current = await FirestoreService.get_receipt(user_id, rid)
                if current and current.get("supplier") != canonical:
                    await FirestoreService.update_receipt(user_id, rid, {"supplier": canonical})
                    stats["supplier_renames"] += 1

        elif atype == "field_propagation":
            field = action["field"]
            value = action["value"]
            for rid in action["target_receipts"]:
                current = await FirestoreService.get_receipt(user_id, rid)
                if current:
                    current_val = current.get(field)
                    if not current_val or str(current_val).strip() in ("", "N/A"):
                        await FirestoreService.update_receipt(user_id, rid, {field: value})
                        stats["fields_filled"] += 1

        elif atype == "duplicate":
            keep_id = action.get("keep_id")
            for rid in action.get("delete_ids", []):
                receipt = await FirestoreService.get_receipt(user_id, rid)
                if receipt:
                    if receipt.get("imageUrl"):
                        from app.services.firebase_service import StorageService
                        await StorageService.delete_receipt_image(receipt["imageUrl"])
                    await FirestoreService.delete_receipt(user_id, rid)
                    stats["duplicates_removed"] += 1

    return stats
