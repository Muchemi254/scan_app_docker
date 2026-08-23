"""
Tests for the pure data-cleaning suggestion logic (no DB required).

Covers:
  - total mismatches: percentage-based rounding tolerance; % deviation shown
    and used for ordering so decimal drift (1500 vs 1498.98) never floods
    real errors
  - supplier-merge variant exclusion: one wrong spelling in an otherwise
    correct cluster can be kept separate, individually
"""

from app.services import data_cleaning_service as d


def _item(qty, price, tax="0", discount=""):
    return {"quantity": qty, "price": price, "tax": tax, "discount": discount}


def _rec(rid, total, items):
    return {"id": rid, "supplier": f"S {rid}", "totalAmount": str(total), "items": items}


# ── Total mismatches ──────────────────────────────────────────────────────────


def test_decimal_drift_below_pct_threshold_not_flagged():
    receipts = [
        # 2 × (700 + 50.49) = 1500.98 vs stored 1500 → 0.98 KSh, 0.07% → rounding
        _rec("r1", "1500", [_item(2, "700", "50.49")]),
    ]
    assert d.suggest_total_mismatches(receipts) == []


def test_small_absolute_below_floor_not_flagged():
    receipts = [
        # 0.01 KSh below the 1.0 KSh absolute floor on a small receipt
        _rec("r2", "45", [_item(1, "44.99")]),
    ]
    assert d.suggest_total_mismatches(receipts) == []


def test_real_mismatch_flagged_with_pct():
    receipts = [
        # 600 KSh off on a 1500 total — clearly real
        _rec("r3", "1500", [_item(3, "400", "300")]),
    ]
    out = d.suggest_total_mismatches(receipts)
    assert len(out) == 1
    m = out[0]
    assert m["id"] == "r3"
    assert m["variance"] == 600.0
    assert m["variance_pct"] == round(600 / 2100 * 100, 3)


def test_sorted_by_relative_deviation():
    receipts = [
        # huge absolute (1000) but only 10% off
        _rec("big", "10000", [_item(1, "9000")]),
        # small absolute (60) but 60% off
        _rec("small", "100", [_item(1, "40")]),
    ]
    out = d.suggest_total_mismatches(receipts)
    assert [m["id"] for m in out] == ["small", "big"]
    assert abs(out[0]["variance_pct"]) == 60.0
    assert abs(out[1]["variance_pct"]) == 10.0


# ── Merge variant exclusion ───────────────────────────────────────────────────


def _cluster():
    return {
        "canonical": "Shop A",
        "variants": ["Shop A", "Shop A Inc", "Shop A Ltd", "Zulu Mart"],
        "scores": [1.0, 0.9, 0.85, 0.82],
        "receipt_ids": ["a1", "a2", "a3", "z1"],
        "variant_receipt_ids": {
            "Shop A": ["a1"],
            "Shop A Inc": ["a2"],
            "Shop A Ltd": ["a3"],
            "Zulu Mart": ["z1"],
        },
    }


def test_exclude_wrong_variant_keeps_merge():
    cluster = _cluster()
    out = d._exclude_merge_variants([cluster], {"mergex|Zulu Mart"})
    assert len(out) == 1
    c = out[0]
    assert c["variants"] == ["Shop A", "Shop A Inc", "Shop A Ltd"]
    assert c["receipt_ids"] == ["a1", "a2", "a3"]
    assert c["canonical"] == "Shop A"


def test_exclude_canonical_repicks_most_frequent():
    cluster = _cluster()
    out = d._exclude_merge_variants([cluster], {"mergex|Shop A"})
    assert len(out) == 1
    c = out[0]
    assert c["canonical"] == "Shop A Inc"
    assert set(c["variants"]) == {"Shop A Inc", "Shop A Ltd", "Zulu Mart"}


def test_cluster_with_single_remaining_variant_dropped():
    cluster = _cluster()
    out = d._exclude_merge_variants(
        [cluster], {"mergex|Zulu Mart", "mergex|Shop A Inc", "mergex|Shop A Ltd"}
    )
    assert out == []


def test_ignore_key_for_merge_variant():
    assert d._ignore_key({"type": "merge_variant", "value": "Shop B"}) == "mergex|Shop B"
