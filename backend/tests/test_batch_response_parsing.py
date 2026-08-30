"""
Tests for batch response parsing in extract_receipt_batch.

Qwen3-VL (DashScope OpenAI-compatible) collapses a top-level JSON array to a
single element under `response_format={"type": "json_object"}` — the "N images
in, 1 receipt out" bug. The batch prompt now nests the array inside a single
object, the parser unwraps it, and a count mismatch raises an error that the
worker classifies as AI_INVALID_JSON so it falls back to per-image extraction.

The AI call itself is mocked; only the request/response parsing is exercised.
"""

import json

import pytest

from app.services.gemini import extract_receipt_batch, call_qwen_api
from app.services.error_codes import classify_exception, should_fan_out_to_per_image

# Grouped per-file parts (new batch contract): one inner list per receipt.
FILES = [
    [{"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,aGVsbG8="}}],
    [{"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,d29ybGQ="}}],
]


def _receipt_dict(supplier, invoice):
    return {
        "supplier": supplier,
        "totalAmount": "123.45",
        "taxAmount": "18.45",
        "receiptDate": "08/14/2026",
        "category": "Groceries",
        "invoiceNumber": invoice,
        "kraPin": "P05115959U",
        "buyerKraPin": "A00112233Z",
        "cuInvoice": "004084202207080184",
        "items": [{"name": "Milk", "quantity": 2, "price": "50.00", "tax": "0.00", "isZeroRated": False}],
    }


async def test_batch_wrapper_object_parsed(monkeypatch):
    async def fake_qwen(api_key, model_id, prompt, content=None, thinking_mode=False, max_tokens=None):
        assert max_tokens is not None, "batch should request an explicit max_tokens"
        receipts = [_receipt_dict("ACME", "INV-1"), _receipt_dict("BETA", "INV-2")]
        receipts[0]["imageIndex"] = 0
        receipts[1]["imageIndex"] = 1
        return json.dumps({"receipts": receipts})

    monkeypatch.setattr("app.services.gemini.call_qwen_api", fake_qwen)
    results = await extract_receipt_batch(FILES, "sk-test", "qwen3-vl-flash", "qwen")
    assert len(results) == 2
    assert results[0].supplier == "ACME"
    assert results[1].supplier == "BETA"


async def test_batch_reorders_by_image_index(monkeypatch):
    """The reported bug: model returns receipts in a DIFFERENT array order than
    the images were presented. imageIndex must win over array position."""
    async def fake_qwen(api_key, model_id, prompt, content=None, thinking_mode=False, max_tokens=None):
        # Image 0 is ACME, image 1 is BETA. The model read both but emitted the
        # array in the opposite order, correctly labeling each receipt's source.
        receipts = [_receipt_dict("BETA", "INV-2"), _receipt_dict("ACME", "INV-1")]
        receipts[0]["imageIndex"] = 1  # BETA came from image 1
        receipts[1]["imageIndex"] = 0  # ACME came from image 0
        return json.dumps({"receipts": receipts})

    monkeypatch.setattr("app.services.gemini.call_qwen_api", fake_qwen)
    results = await extract_receipt_batch(FILES, "sk-test", "qwen3-vl-flash", "qwen")
    assert len(results) == 2
    assert results[0].supplier == "ACME", "receipt for image 0 must be first after reassembly"
    assert results[1].supplier == "BETA", "receipt for image 1 must be second after reassembly"


async def test_batch_partial_indices_raises(monkeypatch):
    """Some receipts declared an image, others did not — ordering is untrustworthy."""
    async def fake_qwen(api_key, model_id, prompt, content=None, thinking_mode=False, max_tokens=None):
        receipts = [_receipt_dict("ACME", "INV-1"), _receipt_dict("BETA", "INV-2")]
        receipts[0]["imageIndex"] = 0
        return json.dumps({"receipts": receipts})

    monkeypatch.setattr("app.services.gemini.call_qwen_api", fake_qwen)
    with pytest.raises(ValueError) as exc:
        await extract_receipt_batch(FILES, "sk-test", "qwen3-vl-flash", "qwen")
    assert "inconsistent imageIndex" in str(exc.value)


async def test_batch_duplicate_index_raises(monkeypatch):
    async def fake_qwen(api_key, model_id, prompt, content=None, thinking_mode=False, max_tokens=None):
        receipts = [_receipt_dict("ACME", "INV-1"), _receipt_dict("BETA", "INV-2")]
        receipts[0]["imageIndex"] = 0
        receipts[1]["imageIndex"] = 0
        return json.dumps({"receipts": receipts})

    monkeypatch.setattr("app.services.gemini.call_qwen_api", fake_qwen)
    with pytest.raises(ValueError) as exc:
        await extract_receipt_batch(FILES, "sk-test", "qwen3-vl-flash", "qwen")
    assert "invalid or duplicate imageIndex" in str(exc.value)


async def test_batch_out_of_range_index_raises(monkeypatch):
    async def fake_qwen(api_key, model_id, prompt, content=None, thinking_mode=False, max_tokens=None):
        receipts = [_receipt_dict("ACME", "INV-1"), _receipt_dict("BETA", "INV-2")]
        receipts[0]["imageIndex"] = 5
        receipts[1]["imageIndex"] = 1
        return json.dumps({"receipts": receipts})

    monkeypatch.setattr("app.services.gemini.call_qwen_api", fake_qwen)
    with pytest.raises(ValueError) as exc:
        await extract_receipt_batch(FILES, "sk-test", "qwen3-vl-flash", "qwen")
    assert "invalid or duplicate imageIndex" in str(exc.value)


async def test_batch_non_numeric_index_raises(monkeypatch):
    async def fake_qwen(api_key, model_id, prompt, content=None, thinking_mode=False, max_tokens=None):
        receipts = [_receipt_dict("ACME", "INV-1"), _receipt_dict("BETA", "INV-2")]
        receipts[0]["imageIndex"] = "first"
        receipts[1]["imageIndex"] = 1
        return json.dumps({"receipts": receipts})

    monkeypatch.setattr("app.services.gemini.call_qwen_api", fake_qwen)
    with pytest.raises(ValueError) as exc:
        await extract_receipt_batch(FILES, "sk-test", "qwen3-vl-flash", "qwen")
    assert "non-numeric imageIndex" in str(exc.value)


async def test_batch_permutation_error_triggers_per_image_fanout(monkeypatch):
    async def fake_qwen(api_key, model_id, prompt, content=None, thinking_mode=False, max_tokens=None):
        receipts = [_receipt_dict("ACME", "INV-1"), _receipt_dict("BETA", "INV-2")]
        receipts[0]["imageIndex"] = 0
        receipts[1]["imageIndex"] = 0
        return json.dumps({"receipts": receipts})

    monkeypatch.setattr("app.services.gemini.call_qwen_api", fake_qwen)
    with pytest.raises(ValueError) as exc:
        await extract_receipt_batch(FILES, "sk-test", "qwen3-vl-flash", "qwen")

    scan_error = classify_exception(exc.value)
    assert scan_error.code.value == "AI_INVALID_JSON"
    assert should_fan_out_to_per_image(scan_error.code) is True


async def test_batch_short_array_raises_count_error(monkeypatch):
    async def fake_qwen(api_key, model_id, prompt, content=None, thinking_mode=False, max_tokens=None):
        return json.dumps({"receipts": [_receipt_dict("ACME", "INV-1")]})

    monkeypatch.setattr("app.services.gemini.call_qwen_api", fake_qwen)
    with pytest.raises(ValueError) as exc:
        await extract_receipt_batch(FILES, "sk-test", "qwen3-vl-flash", "qwen")
    assert "expecting 2" in str(exc.value)
    assert "received 1" in str(exc.value)


async def test_batch_empty_supplier_does_not_fail(monkeypatch):
    """OCR models (e.g. qwen-vl-ocr) fill unreadable fields with "" instead of
    omitting them or using 'N/A'. supplier has min_length=1, so a literal empty
    string used to trip a Pydantic validation error and the item was marked
    AI_EMPTY_RESPONSE. Empty/whitespace supplier must fall back to 'Unknown'."""
    async def fake_qwen(api_key, model_id, prompt, content=None, thinking_mode=False, max_tokens=None):
        receipts = [_receipt_dict("ACME", "INV-1"), _receipt_dict("BETA", "INV-2")]
        receipts[0]["imageIndex"] = 0
        receipts[1]["imageIndex"] = 1
        receipts[1]["supplier"] = ""
        return json.dumps({"receipts": receipts})

    monkeypatch.setattr("app.services.gemini.call_qwen_api", fake_qwen)
    results = await extract_receipt_batch(FILES, "sk-test", "qwen-vl-ocr", "qwen")
    assert len(results) == 2
    assert results[0].supplier == "ACME"
    assert results[1].supplier == "Unknown", "empty supplier must become 'Unknown', not fail"


async def test_batch_single_object_coercion_raises_count_error(monkeypatch):
    """The exact Qwen symptom: asked for 2, got 1 bare object instead of an array."""
    async def fake_qwen(api_key, model_id, prompt, content=None, thinking_mode=False, max_tokens=None):
        return json.dumps(_receipt_dict("ACME", "INV-1"))

    monkeypatch.setattr("app.services.gemini.call_qwen_api", fake_qwen)
    with pytest.raises(ValueError) as exc:
        await extract_receipt_batch(FILES, "sk-test", "qwen3-vl-flash", "qwen")
    assert "expecting 2" in str(exc.value)


async def test_batch_non_dict_entry_raises(monkeypatch):
    async def fake_qwen(api_key, model_id, prompt, content=None, thinking_mode=False, max_tokens=None):
        return json.dumps({"receipts": [_receipt_dict("ACME", "INV-1"), "an error message instead of JSON"]})

    monkeypatch.setattr("app.services.gemini.call_qwen_api", fake_qwen)
    with pytest.raises(ValueError) as exc:
        await extract_receipt_batch(FILES, "sk-test", "qwen3-vl-flash", "qwen")
    assert "entry 1 is not an object" in str(exc.value)


async def test_batch_plain_array_backcompat(monkeypatch):
    async def fake_qwen(api_key, model_id, prompt, content=None, thinking_mode=False, max_tokens=None):
        return json.dumps([_receipt_dict("ACME", "INV-1"), _receipt_dict("BETA", "INV-2")])

    monkeypatch.setattr("app.services.gemini.call_qwen_api", fake_qwen)
    results = await extract_receipt_batch(FILES, "sk-test", "qwen3-vl-flash", "qwen")
    assert len(results) == 2


async def test_batch_items_drop_tax_and_discount(monkeypatch):
    """AI-invented per-item tax/discount must NOT be persisted — they distort
    line totals (qty * (price + tax) * (1 - discount/100)) versus the printed
    VAT-inclusive total and force the user to clear them item by item."""
    async def fake_qwen(api_key, model_id, prompt, content=None, thinking_mode=False, max_tokens=None):
        receipts = [_receipt_dict("ACME", "INV-1"), _receipt_dict("BETA", "INV-2")]
        for idx, r in enumerate(receipts):
            r["imageIndex"] = idx
            for it in r["items"]:
                it["tax"] = "12.00"
                it["discount"] = "10"
        return json.dumps({"receipts": receipts})

    monkeypatch.setattr("app.services.gemini.call_qwen_api", fake_qwen)
    results = await extract_receipt_batch(FILES, "sk-test", "qwen3-vl-flash", "qwen")
    assert len(results) == 2
    for r in results:
        assert r.items, "each receipt should have items"
        for item in r.items:
            assert item.tax is None, "per-item tax must not be persisted from AI"
            assert item.discount is None, "per-item discount must not be persisted from AI"


async def test_count_error_triggers_per_image_fanout(monkeypatch):
    async def fake_qwen(api_key, model_id, prompt, content=None, thinking_mode=False, max_tokens=None):
        return json.dumps({"receipts": [_receipt_dict("ACME", "INV-1")]})

    monkeypatch.setattr("app.services.gemini.call_qwen_api", fake_qwen)
    with pytest.raises(ValueError) as exc:
        await extract_receipt_batch(FILES, "sk-test", "qwen3-vl-flash", "qwen")

    scan_error = classify_exception(exc.value)
    assert scan_error.code.value == "AI_INVALID_JSON"
    assert should_fan_out_to_per_image(scan_error.code) is True
