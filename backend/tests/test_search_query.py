from app.services.search_query import (
    item_index_text,
    item_search_text,
    item_search_vector,
    like_pattern,
    receipt_index_text,
    receipt_search_text,
    receipt_search_vector,
)


def test_like_pattern_escapes_pattern_characters():
    assert like_pattern("100%_\\") == "100\\%\\_\\\\"


def test_search_vectors_include_receipt_and_item_fields():
    receipt_text = receipt_search_text()
    item_text = item_search_text()

    assert "receipt_date::text" in receipt_text
    assert "location" in receipt_text
    assert "quantity::text" in item_text
    assert "discount::text" in item_text
    assert receipt_index_text() in receipt_search_vector()
    assert item_index_text() in item_search_vector()
