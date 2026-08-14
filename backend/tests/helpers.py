"""Shared test helpers: auth login, admin user creation, sample images/data."""

import io

from PIL import Image

ADMIN_EMAIL = "admin@pytest.local"
ADMIN_PASSWORD = "admin-password-123!"


async def login(client, email, password):
    """POST /auth/login → (auth headers, user dict, raw token)."""
    resp = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": password},
    )
    assert resp.status_code == 200, f"login failed: {resp.status_code} {resp.text}"
    data = resp.json()
    headers = {"Authorization": f"Bearer {data['access_token']}"}
    return headers, data["user"], data["access_token"]


async def create_user_via_admin(client, admin_headers, email, password, **kwargs):
    """POST /auth/admin/users → created user dict."""
    body = {"email": email, "password": password, **kwargs}
    resp = await client.post("/api/v1/auth/admin/users", json=body, headers=admin_headers)
    assert resp.status_code == 201, f"admin create failed: {resp.status_code} {resp.text}"
    return resp.json()


def make_jpeg_bytes(width=160, height=80, color=(240, 240, 240)):
    """Generate a small valid JPEG that passes process_image()."""
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color).save(buf, format="JPEG")
    return buf.getvalue()


def sample_receipt(supplier="ACME Grocery", invoice="INV-1001"):
    """A ReceiptCreate-shaped dict returned by the mocked AI extractor."""
    return {
        "supplier": supplier,
        "totalAmount": "123.45",
        "taxAmount": "18.45",
        "receiptDate": "08/14/2026",
        "category": "Groceries",
        "invoiceNumber": invoice,
        "items": [
            {"name": "Milk", "quantity": 2, "price": "50.00", "tax": "0.00", "isZeroRated": False, "discount": None},
            {"name": "Bread", "quantity": 1, "price": "23.45", "tax": "0.00", "isZeroRated": False, "discount": None},
        ],
    }
