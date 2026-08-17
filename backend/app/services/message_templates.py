"""
Predefined message templates for the receipt workflow.

Templates are the canonical way to send structured receipt messages: the
server renders the body from a template key + variables, so the chat bubble
always carries a rich payload (supplier / total / invoice / note / ...) on
top of the human-readable text. Placeholders are {braced} variable names.

Used by:
  - GET /messages/templates        (catalog for the compose box)
  - POST /messages/send            (template_key + variables → rendered message)
  - the workflow auto-messages are built directly in receipt_workflow_service
"""

from typing import Any, Dict, List, Optional

VARIABLE_NAMES = {
    "supplier": "Receipt supplier",
    "total": "Total amount (KES)",
    "date": "Receipt date",
    "invoice_number": "Invoice number",
    "receipt_id": "Receipt short id",
    "note": "Admin note",
    "field": "Missing field name",
    "duplicate_invoice": "Invoice of the suspected duplicate",
    "payment_status": "Payment status (e.g. paid, scheduled)",
}

_SYSTEM_VARIABLES = {"receipt_id"}  # always available on receipt threads


class Template:
    def __init__(self, key, kind, title, description, body, variables):
        self.key = key
        self.kind = kind
        self.title = title
        self.description = description
        self.body = body
        self.variables = variables

    def to_dict(self) -> Dict[str, Any]:
        return {
            "key": self.key,
            "kind": self.kind,
            "title": self.title,
            "description": self.description,
            "body": self.body,
            "variables": list(self.variables),
        }


TEMPLATES: List[Template] = [
    Template(
        "approval_confirmed",
        "receipt_approval",
        "Approved",
        "Notify the user that their receipt was approved and processed.",
        "Your receipt from {supplier} (KES {total}) was approved and is now "
        "fully processed. Thank you!",
        {"supplier", "total", "invoice_number"},
    ),
    Template(
        "rejection_reason",
        "receipt_rejection",
        "Rejected",
        "Notify the user that their receipt was rejected, with a reason.",
        "Your receipt from {supplier} (KES {total}) was rejected. "
        "Reason: {note}",
        {"supplier", "total", "note", "invoice_number"},
    ),
    Template(
        "question_supplier",
        "receipt_question",
        "Question — Supplier",
        "Ask the user to clarify the supplier on a receipt.",
        "Could you confirm the supplier for receipt {receipt_id}?",
        {"supplier"},
    ),
    Template(
        "question_amount",
        "receipt_question",
        "Question — Amount",
        "Ask the user to confirm an amount that doesn't add up.",
        "The total on receipt {receipt_id} reads {total}, which doesn't match "
        "what we expected. Please confirm the correct amount.",
        {"total", "supplier"},
    ),
    Template(
        "question_date",
        "receipt_question",
        "Question — Date",
        "Ask the user to confirm the receipt date.",
        "Please confirm the receipt date on {receipt_id} (currently {date}).",
        {"date", "supplier"},
    ),
    Template(
        "missing_info",
        "receipt_missing_info",
        "Missing information",
        "Request a specific missing field (invoice, PIN, location, ...).",
        "Please provide the missing {field} for receipt {receipt_id}. "
        "Once added, you can resubmit it for approval.",
        {"field", "supplier"},
    ),
    Template(
        "possible_duplicate",
        "receipt_duplicate",
        "Possible duplicate",
        "Flag a likely duplicate against another invoice.",
        "Receipt {receipt_id} ({supplier}, KES {total}) looks like a duplicate "
        "of invoice {duplicate_invoice}. Please verify and confirm.",
        {"supplier", "total", "duplicate_invoice"},
    ),
    Template(
        "payment_notice",
        "receipt_payment",
        "Payment notice",
        "Tell the user the payment status for a receipt.",
        "Payment for {supplier} (KES {total}) has been {payment_status}. "
        "Reference: {invoice_number}.",
        {"supplier", "total", "payment_status", "invoice_number"},
    ),
]

_KEY_INDEX = {t.key: t for t in TEMPLATES}


def list_templates() -> List[Dict[str, Any]]:
    return [t.to_dict() for t in TEMPLATES]


def render_template(
    key: str, variables: Optional[Dict[str, Any]]
) -> tuple[str, str, Dict[str, Any]]:
    """Render a template to (kind, body, payload); raises ValueError on
    unknown keys. Variables the template doesn't reference are still kept in
    the payload for the rich bubble; empty variables render as '—'."""
    tmpl = _KEY_INDEX.get(key)
    if not tmpl:
        raise ValueError(f"Unknown message template: {key}")
    vars_map: Dict[str, Any] = dict(variables or {})
    missing: List[str] = []
    body = tmpl.body
    for name in sorted(
        set(tmpl.variables) | (set(vars_map.keys()) & (set(VARIABLE_NAMES) | _SYSTEM_VARIABLES)),
        key=lambda n: (-len(n), n),
    ):
        token = "{" + name + "}"
        if token not in body:
            continue
        value = vars_map.get(name)
        if value is None or str(value).strip() == "":
            missing.append(name)
            value = "—"
        body = body.replace(token, str(value))
    if missing and key != "rejection_reason":
        body = body.rstrip()
    payload = dict(vars_map)
    payload["template_key"] = key
    return tmpl.kind, body, payload


def known_variables() -> Dict[str, str]:
    return dict(VARIABLE_NAMES)