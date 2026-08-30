"""
Data adapter — routes to PostgreSQL or Firestore based on USE_POSTGRES flag.

Every method mirrors the interface of DatabaseService / FirestoreService.
API routes import from here instead of directly from either service.
"""

import logging
from typing import Optional, List, Dict, Any
from app.core.config import settings

logger = logging.getLogger(__name__)

_PG_AVAILABLE = False
try:
    from app.services.database_service import (
        DatabaseService, save_image, save_thumbnail,
        save_pdf, save_pdf_thumbnail,
        delete_receipt_images, read_image,
    )
    _PG_AVAILABLE = True
except Exception:
    pass


class DataService:
    """Routes to PostgreSQL (DatabaseService) or Firestore (FirestoreService)."""

    @classmethod
    def _backend(cls):
        if settings.USE_POSTGRES and _PG_AVAILABLE:
            from app.services.database_service import DatabaseService as DB
            return DB, "postgres"
        from app.services.firebase_service import FirestoreService as DB
        return DB, "firestore"

    # ── Receipt CRUD ─────────────────────────────────────────────────────

    @classmethod
    async def create_receipt(cls, user_id: str, receipt_data: Dict[str, Any]) -> str:
        db, backend = cls._backend()
        logger.debug("create_receipt → %s", backend)
        return await db.create_receipt(user_id, receipt_data)

    @classmethod
    async def get_receipt(cls, user_id: str, receipt_id: str) -> Optional[Dict[str, Any]]:
        db, _ = cls._backend()
        return await db.get_receipt(user_id, receipt_id)

    @classmethod
    async def get_receipts_by_ids(cls, user_id: str, receipt_ids: List[str]) -> List[Dict[str, Any]]:
        db, _ = cls._backend()
        return await db.get_receipts_by_ids(user_id, receipt_ids)

    @classmethod
    async def list_receipts(
        cls, user_id: str, skip: int = 0, limit: int = 50,
        status: Optional[str] = None, category: Optional[str] = None,
        batch_title: Optional[str] = None, rejected: bool = False,
        has_image: Optional[bool] = None, entry_type: Optional[str] = None,
    ) -> tuple:
        db, _ = cls._backend()
        return await db.list_receipts(
            user_id, skip, limit, status, category, batch_title, rejected,
            has_image, entry_type,
        )

    @classmethod
    async def update_receipt(cls, user_id: str, receipt_id: str, receipt_data: Dict[str, Any]) -> bool:
        db, _ = cls._backend()
        return await db.update_receipt(user_id, receipt_id, receipt_data)

    @classmethod
    async def delete_receipt(cls, user_id: str, receipt_id: str) -> bool:
        db, _ = cls._backend()
        return await db.delete_receipt(user_id, receipt_id)

    @classmethod
    async def search_receipts(
        cls, user_id: str, supplier: Optional[str] = None,
        category: Optional[str] = None, date_from: Optional[str] = None,
        date_to: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        db, _ = cls._backend()
        return await db.search_receipts(user_id, supplier, category, date_from, date_to)

    @classmethod
    async def search_receipts_fulltext(
        cls, user_id: str, query: str, limit: int = 50, offset: int = 0,
        **filters: Any,
    ) -> dict:
        db, _ = cls._backend()
        return await db.search_receipts_fulltext(user_id, query, limit, offset, **filters)

    @classmethod
    async def check_duplicate(
        cls, user_id: str, supplier: Optional[str] = None,
        totalAmount: Optional[str] = None, receiptDate: Optional[str] = None,
        invoiceNumber: Optional[str] = None, exclude_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        db, _ = cls._backend()
        return await db.check_duplicate(user_id, supplier, totalAmount, receiptDate, invoiceNumber, exclude_id)

    @classmethod
    async def get_receipt_groups(cls, user_id: str) -> List[Dict[str, Any]]:
        db, _ = cls._backend()
        return await db.get_receipt_groups(user_id)

    # ── Locations (admin-managed reference data) ──────────────────────────

    @classmethod
    async def list_locations(cls, active_only: bool = False) -> List[Dict[str, Any]]:
        db, _ = cls._backend()
        if hasattr(db, "list_locations"):
            return await db.list_locations(active_only=active_only)
        return []

    @classmethod
    async def get_location(cls, location_id: str) -> Optional[Dict[str, Any]]:
        db, _ = cls._backend()
        if hasattr(db, "get_location"):
            return await db.get_location(location_id)
        return None

    @classmethod
    async def create_location(cls, name: str, created_by: Optional[str] = None) -> Optional[Dict[str, Any]]:
        db, _ = cls._backend()
        if hasattr(db, "create_location"):
            return await db.create_location(name, created_by)
        return None

    @classmethod
    async def update_location(cls, location_id: str, data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        db, _ = cls._backend()
        if hasattr(db, "update_location"):
            return await db.update_location(location_id, data)
        return None

    @classmethod
    async def delete_location(cls, location_id: str) -> bool:
        db, _ = cls._backend()
        if hasattr(db, "delete_location"):
            return await db.delete_location(location_id)
        return False

    @classmethod
    async def find_receipts_by_image_hashes(
        cls, user_id: str, hashes: List[str]
    ) -> Dict[str, str]:
        """Return {sha256 -> receipt_id} for existing receipts. PG only."""
        db, backend = cls._backend()
        if backend != "postgres" or not hasattr(db, "find_receipts_by_image_hashes"):
            return {}
        return await db.find_receipts_by_image_hashes(user_id, hashes)

    # ── User AI Settings ─────────────────────────────────────────────────

    @classmethod
    async def get_user_settings(cls, user_id: str, settings_key: str) -> Optional[Dict[str, Any]]:
        db, _ = cls._backend()
        return await db.get_user_settings(user_id, settings_key)

    @classmethod
    async def update_user_settings(cls, user_id: str, settings_key: str, data: Dict[str, Any]) -> bool:
        db, _ = cls._backend()
        return await db.update_user_settings(user_id, settings_key, data)

    # ── User preferences (per-user defaults) ──────────────────────────────

    @classmethod
    async def get_user_default_tax_rate(cls, user_id: str) -> float:
        db, _ = cls._backend()
        if hasattr(db, "get_user_default_tax_rate"):
            return await db.get_user_default_tax_rate(user_id)
        return 16.0

    @classmethod
    async def set_user_default_tax_rate(cls, user_id: str, rate: float) -> None:
        db, _ = cls._backend()
        if hasattr(db, "set_user_default_tax_rate"):
            await db.set_user_default_tax_rate(user_id, rate)


# ── Image helpers (local only, fall back gracefully) ─────────────────────

def _save_image_local(receipt_id: str, jpeg_bytes: bytes) -> str:
    if _PG_AVAILABLE:
        return save_image(receipt_id, jpeg_bytes)
    raise RuntimeError("Local image storage not available (USE_POSTGRES=false)")

def _save_thumbnail_local(receipt_id: str, jpeg_bytes: bytes) -> str:
    if _PG_AVAILABLE:
        return save_thumbnail(receipt_id, jpeg_bytes)
    raise RuntimeError("Local image storage not available (USE_POSTGRES=false)")

def _save_pdf_local(receipt_id: str, pdf_bytes: bytes) -> str:
    if _PG_AVAILABLE:
        return save_pdf(receipt_id, pdf_bytes)
    raise RuntimeError("Local image storage not available (USE_POSTGRES=false)")

def _save_pdf_thumbnail_local(receipt_id: str, pdf_bytes: bytes):
    if _PG_AVAILABLE:
        return save_pdf_thumbnail(receipt_id, pdf_bytes)
    return None

def _delete_receipt_images_local(receipt_id: str) -> None:
    if _PG_AVAILABLE:
        delete_receipt_images(receipt_id)

def _read_image_local(receipt_id: str, thumb: bool = False):
    if _PG_AVAILABLE:
        return read_image(receipt_id, thumb)
    return None
