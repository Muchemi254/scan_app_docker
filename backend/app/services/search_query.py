"""Shared PostgreSQL search expressions."""


def receipt_search_text(alias: str = "r") -> str:
    return (
        f"COALESCE({alias}.supplier, '') || ' ' || COALESCE({alias}.category, '') || ' ' || "
        f"COALESCE({alias}.invoice_number, '') || ' ' || COALESCE({alias}.kra_pin, '') || ' ' || "
        f"COALESCE({alias}.buyer_kra_pin, '') || ' ' || COALESCE({alias}.cu_invoice, '') || ' ' || "
        f"COALESCE({alias}.batch_title, '') || ' ' || COALESCE({alias}.receipt_date::text, '') || ' ' || "
        f"COALESCE({alias}.location, '') || ' ' || COALESCE({alias}.total_amount::text, '')"
    )


def receipt_index_text(alias: str = "r") -> str:
    return (
        f"COALESCE({alias}.supplier, '') || ' ' || COALESCE({alias}.category, '') || ' ' || "
        f"COALESCE({alias}.invoice_number, '') || ' ' || COALESCE({alias}.kra_pin, '') || ' ' || "
        f"COALESCE({alias}.buyer_kra_pin, '') || ' ' || COALESCE({alias}.cu_invoice, '') || ' ' || "
        f"COALESCE({alias}.batch_title, '') || ' ' || COALESCE({alias}.location, '')"
    )


def item_search_text(alias: str = "li") -> str:
    return (
        f"COALESCE({alias}.name, '') || ' ' || COALESCE({alias}.quantity::text, '') || ' ' || "
        f"COALESCE({alias}.price::text, '') || ' ' || COALESCE({alias}.tax::text, '') || ' ' || "
        f"COALESCE({alias}.discount::text, '')"
    )


def item_index_text(alias: str = "li") -> str:
    return f"COALESCE({alias}.name, '')"


def receipt_search_vector(alias: str = "r") -> str:
    return f"to_tsvector('simple', {receipt_index_text(alias)})"


def item_search_vector(alias: str = "li") -> str:
    return f"to_tsvector('simple', {item_index_text(alias)})"


def like_pattern(query: str) -> str:
    """Escape user input before it is used in an ILIKE pattern."""
    return query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
