import logging
from difflib import SequenceMatcher
from typing import List, Dict, Any
from collections import defaultdict

from app.services.data_adapter import DataService
from app.core.config import settings

logger = logging.getLogger(__name__)

SIMILARITY_THRESHOLD = 0.80

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

def _ids_match(a_val: str, b_val: str) -> bool:
    """Two identifier strings match — both non-empty and equal."""
    return bool(a_val) and bool(b_val) and a_val == b_val


def suggest_duplicates(receipts: List[dict]) -> List[dict]:
    """Find receipts that are likely duplicates.

    Rules (high-confidence only, no false positives from dates/names):
    - Any matching invoice identifier (invoiceNumber, cuInvoice) → definite duplicate.
    - Same totalAmount (exact match, both > 0) → high-confidence duplicate.
    - Date, supplier name, or KRA PIN alone do NOT constitute a duplicate.
    """
    checked = set()
    duplicates = []

    for i, a in enumerate(receipts):
        if a["id"] in checked:
            continue
        a_inv = (a.get("invoiceNumber") or "").strip()
        a_cu = (a.get("cuInvoice") or "").strip()
        a_amt = _to_float(a.get("totalAmount"))

        pair_group = {"receipts": [a], "keep_id": a["id"], "scores": [1.0]}

        for j in range(i + 1, len(receipts)):
            b = receipts[j]
            if b["id"] in checked:
                continue
            b_inv = (b.get("invoiceNumber") or "").strip()
            b_cu = (b.get("cuInvoice") or "").strip()
            b_amt = _to_float(b.get("totalAmount"))

            # Rule 1: Any matching invoice identifier → definite duplicate
            if _ids_match(a_inv, b_inv) or _ids_match(a_cu, b_cu):
                pair_group["receipts"].append(b)
                pair_group["scores"].append(1.0)
                checked.add(b["id"])
                checked.add(a["id"])
                continue

            # Rule 2: Same totalAmount → high-confidence duplicate
            if a_amt > 0 and b_amt > 0 and a_amt == b_amt:
                pair_group["receipts"].append(b)
                pair_group["scores"].append(0.95)
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
                current = await DataService.get_receipt(user_id, rid)
                if current and current.get("supplier") != canonical:
                    await DataService.update_receipt(user_id, rid, {"supplier": canonical})
                    stats["supplier_renames"] += 1

        elif atype == "field_propagation":
            field = action["field"]
            value = action["value"]
            for rid in action["target_receipts"]:
                current = await DataService.get_receipt(user_id, rid)
                if current:
                    current_val = current.get(field)
                    if not current_val or str(current_val).strip() in ("", "N/A"):
                        await DataService.update_receipt(user_id, rid, {field: value})
                        stats["fields_filled"] += 1

        elif atype == "duplicate":
            keep_id = action.get("keep_id")
            for rid in action.get("delete_ids", []):
                receipt = await DataService.get_receipt(user_id, rid)
                if receipt:
                    if settings.USE_POSTGRES:
                        from app.services.database_service import delete_receipt_images
                        delete_receipt_images(rid)
                    elif receipt.get("imageUrl"):
                        from app.services.firebase_service import StorageService
                        await StorageService.delete_receipt_image(receipt["imageUrl"])
                    await DataService.delete_receipt(user_id, rid)
                    stats["duplicates_removed"] += 1

    return stats
