"""
Firebase service wrapper.

Abstracts Firebase operations for easy migration:
- Auth, Firestore, Storage

Design:
- All Firebase calls go through this layer
- Easy to swap with PostgreSQL/local storage later
- Multi-tenant aware
"""

import logging
import json
import os
from typing import Optional, List, Dict, Any
from datetime import datetime
import firebase_admin
from firebase_admin import credentials, firestore, storage
from app.core.config import settings

logger = logging.getLogger(__name__)

# Initialize Firebase (only once)
_firebase_initialized = False


def init_firebase():
    """Initialize Firebase Admin SDK using service account JSON file."""
    global _firebase_initialized

    if _firebase_initialized:
        return

    try:
        # Load credentials from service account JSON file
        creds_path = settings.FIREBASE_CREDENTIALS_PATH

        # Try the provided path first
        if not json_file_exists(creds_path):
            # Fallback to current directory for local development
            local_path = "./firebaseservice.json"
            if json_file_exists(local_path):
                creds_path = local_path
                logger.info(f"Using Firebase credentials from: {creds_path}")
            else:
                raise FileNotFoundError(
                    f"Firebase service account JSON not found at {creds_path} or {local_path}"
                )

        logger.info(f"Loading Firebase credentials from: {creds_path}")

        # Load and validate the JSON file
        with open(creds_path) as json_file:
            service_account_info = json.load(json_file)

        # Validate required fields
        required_fields = ["type", "project_id", "private_key", "client_email"]
        missing_fields = [f for f in required_fields if f not in service_account_info]

        if missing_fields:
            raise ValueError(
                f"Firebase service account JSON missing required fields: {missing_fields}"
            )

        # Initialize Firebase with the service account
        cred = credentials.Certificate(service_account_info)
        firebase_admin.initialize_app(
            cred,
            {
                "storageBucket": service_account_info.get("storage_bucket") or
                                 f"{service_account_info['project_id']}.appspot.com",
            }
        )

        _firebase_initialized = True
        logger.info(f"Firebase initialized successfully for project: {service_account_info['project_id']}")

    except FileNotFoundError as e:
        logger.error(f"Firebase service account file not found: {e}")
        raise
    except json.JSONDecodeError as e:
        logger.error(f"Firebase service account JSON is invalid: {e}")
        raise
    except Exception as e:
        logger.error(f"Failed to initialize Firebase: {e}")
        raise


def json_file_exists(path: str) -> bool:
    """Check if a JSON file exists and is readable."""
    try:
        return os.path.exists(path) and os.path.isfile(path)
    except Exception:
        return False


# Lazy initialize Firebase - will be called when first needed
db = None
bucket = None


def get_db():
    """Get Firestore client (lazy initialization)."""
    global db, _firebase_initialized

    if not _firebase_initialized:
        init_firebase()

    if db is None:
        db = firestore.client()

    return db


def get_bucket():
    """Get Storage bucket (lazy initialization)."""
    global bucket, _firebase_initialized

    if not _firebase_initialized:
        init_firebase()

    if bucket is None:
        bucket = storage.bucket()

    return bucket


class FirestoreService:
    """Wrapper for Firestore operations."""

    @staticmethod
    async def get_user_settings(user_id: str, settings_key: str) -> Optional[Dict[str, Any]]:
        """Get user-specific settings."""
        try:
            doc = get_db().document(f"users/{user_id}/settings/{settings_key}").get()
            if not doc.exists:
                return None
            return doc.to_dict()
        except Exception as e:
            logger.error(f"Failed to get user settings: {e}")
            raise

    @staticmethod
    async def update_user_settings(user_id: str, settings_key: str, data: Dict[str, Any]) -> bool:
        """Update user-specific settings."""
        try:
            get_db().document(f"users/{user_id}/settings/{settings_key}").set(data, merge=True)
            return True
        except Exception as e:
            logger.error(f"Failed to update user settings: {e}")
            raise

    @staticmethod
    async def create_receipt(user_id: str, receipt_data: Dict[str, Any]) -> str:
        """
        Create a new receipt document.

        Args:
            user_id: User ID (from Firebase Auth)
            receipt_data: Receipt data dictionary

        Returns:
            Document ID
        """
        try:
            receipt_data["createdAt"] = datetime.utcnow()
            receipt_data["updatedAt"] = datetime.utcnow()
            receipt_data["scannedAt"] = datetime.utcnow()
            receipt_data["status"] = receipt_data.get("status", "processed")

            doc_ref = get_db().collection(f"users/{user_id}/receipts").document()
            doc_ref.set(receipt_data)

            logger.info(f"Created receipt {doc_ref.id} for user {user_id}")
            return doc_ref.id

        except Exception as e:
            logger.error(f"Failed to create receipt: {e}")
            raise

    @staticmethod
    async def get_receipt(user_id: str, receipt_id: str) -> Optional[Dict[str, Any]]:
        """Get a single receipt by ID."""
        try:
            doc = get_db().document(f"users/{user_id}/receipts/{receipt_id}").get()

            if not doc.exists:
                return None

            data = doc.to_dict()
            data["id"] = doc.id
            if "userId" not in data:
                data["userId"] = user_id
            if "createdAt" not in data or data["createdAt"] is None:
                data["createdAt"] = doc.create_time or datetime.utcnow()
            return data

        except Exception as e:
            logger.error(f"Failed to get receipt: {e}")
            raise

    @staticmethod
    async def get_receipts_by_ids(user_id: str, receipt_ids: List[str]) -> List[Dict[str, Any]]:
        """
        Fetch multiple receipts by their document IDs.

        Uses get_all() with document references — no FieldPath import needed
        and no 10-value limit. Firestore batches the reads internally.
        """
        if not receipt_ids:
            return []

        db = get_db()
        col = db.collection(f"users/{user_id}/receipts")
        results: List[Dict[str, Any]] = []

        # Build document references and fetch in manageable chunks
        refs = [col.document(rid) for rid in receipt_ids]

        for i in range(0, len(refs), 100):
            chunk = refs[i:i + 100]
            docs = db.get_all(chunk)
            for doc in docs:
                if not doc.exists:
                    continue
                data = doc.to_dict()
                data["id"] = doc.id
                if "userId" not in data:
                    data["userId"] = user_id
                if "createdAt" not in data or data["createdAt"] is None:
                    data["createdAt"] = doc.create_time or datetime.utcnow()
                results.append(data)

        return results

    @staticmethod
    async def list_receipts(
        user_id: str,
        skip: int = 0,
        limit: int = 50,
        status: Optional[str] = None,
        category: Optional[str] = None,
        batch_title: Optional[str] = None,
        rejected: bool = False,
        has_image: Optional[bool] = None,
        entry_type: Optional[str] = None,
    ) -> tuple[List[Dict[str, Any]], int]:
        """
        List receipts with filtering and pagination.

        Args:
            user_id: User ID
            skip: Number of documents to skip
            limit: Maximum documents to return
            status: Filter by status (optional)
            category: Filter by category (optional)
            batch_title: Filter by batchTitle (optional)
            rejected: Only receipts whose latest audit action was a rejection.
                Legacy firestore backend: audit-driven rejection filtering is
                not available here — the flag is accepted for interface
                compatibility and filters on status needs_review as a
                best-effort approximation.

        Returns:
            Tuple of (receipts list, total count)
        """
        try:
            query = get_db().collection(f"users/{user_id}/receipts")

            # Apply filters
            if status:
                query = query.where("status", "==", status)
            if category:
                query = query.where("category", "==", category)
            if batch_title and batch_title != "__ungrouped__":
                query = query.where("batchTitle", "==", batch_title)
            if rejected:
                query = query.where("status", "==", "needs_review")

            # Get all matching documents
            all_docs = list(query.stream())

            # Post-query filter for ungrouped receipts (null/empty batchTitle)
            if batch_title == "__ungrouped__":
                all_docs = [
                    d for d in all_docs
                    if not d.to_dict().get("batchTitle")
                    or not d.to_dict().get("batchTitle", "").strip()
                    or d.to_dict().get("batchTitle", "").strip().upper() == "N/A"
                ]

            if has_image is not None:
                all_docs = [
                    d for d in all_docs
                    if bool(d.to_dict().get("imageUrl") or d.to_dict().get("imageFilename")) == has_image
                ]

            if entry_type:
                if entry_type == "non_expense":
                    all_docs = [
                        d for d in all_docs
                        if (d.to_dict().get("entryType") or "expense") != "expense"
                    ]
                else:
                    all_docs = [
                        d for d in all_docs
                        if (d.to_dict().get("entryType") or "expense") == entry_type
                    ]

            total = len(all_docs)

            # Apply pagination
            paginated = all_docs[skip:skip + limit]
            receipts = []
            for doc in paginated:
                data = doc.to_dict()
                data["id"] = doc.id
                # Ensure required fields exist
                if "userId" not in data:
                    data["userId"] = user_id
                if "createdAt" not in data or data["createdAt"] is None:
                    data["createdAt"] = doc.create_time or datetime.utcnow()
                receipts.append(data)

            return receipts, total

        except Exception as e:
            logger.error(f"Failed to list receipts: {e}")
            raise

    @staticmethod
    async def get_receipt_groups(user_id: str) -> List[Dict[str, Any]]:
        """
        Return receipts grouped by batchTitle for gallery browsing.

        Only returns receipts that have an imageUrl.  Groups are sorted by
        most-recent receipt date descending.  "Ungrouped" collects all
        receipts whose batchTitle is None, empty, or "N/A".
        """
        try:
            query = get_db().collection(f"users/{user_id}/receipts")
            all_docs = list(query.stream())

            groups: Dict[str, dict] = {}

            for doc in all_docs:
                data = doc.to_dict()
                if not data.get("imageUrl"):
                    continue

                data["id"] = doc.id
                batch = (data.get("batchTitle") or "").strip()
                if not batch or batch.upper() == "N/A":
                    batch = "Ungrouped"

                if batch not in groups:
                    groups[batch] = {
                        "batchTitle": batch,
                        "count": 0,
                        "thumbnailUrl": data["imageUrl"],
                        "totalAmount": 0.0,
                        "latestDate": "",
                        "firstSupplier": data.get("supplier", ""),
                    }

                g = groups[batch]
                g["count"] += 1
                try:
                    g["totalAmount"] += float(data.get("totalAmount", 0) or 0)
                except (ValueError, TypeError):
                    pass

                rdate = data.get("receiptDate", "")
                if rdate > g["latestDate"]:
                    g["latestDate"] = rdate

            result = sorted(groups.values(), key=lambda g: g["count"], reverse=True)
            for g in result:
                g["totalAmount"] = round(g["totalAmount"], 2)

            return result

        except Exception as e:
            logger.error(f"Failed to get receipt groups: {e}")
            raise

    @staticmethod
    async def update_receipt(
        user_id: str,
        receipt_id: str,
        receipt_data: Dict[str, Any]
    ) -> bool:
        """Update a receipt document."""
        try:
            receipt_data["updatedAt"] = datetime.utcnow()

            get_db().document(f"users/{user_id}/receipts/{receipt_id}").update(receipt_data)

            logger.info(f"Updated receipt {receipt_id} for user {user_id}")
            return True

        except Exception as e:
            logger.error(f"Failed to update receipt: {e}")
            raise

    @staticmethod
    async def delete_receipt(user_id: str, receipt_id: str) -> bool:
        """Delete a receipt document."""
        try:
            get_db().document(f"users/{user_id}/receipts/{receipt_id}").delete()

            logger.info(f"Deleted receipt {receipt_id} for user {user_id}")
            return True

        except Exception as e:
            logger.error(f"Failed to delete receipt: {e}")
            raise

    @staticmethod
    async def search_receipts(
        user_id: str,
        supplier: Optional[str] = None,
        category: Optional[str] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """
        Advanced search with multiple filters.

        Args:
            user_id: User ID
            supplier: Filter by supplier name
            category: Filter by category
            date_from: Filter by date range (from)
            date_to: Filter by date range (to)

        Returns:
            List of matching receipts
        """
        try:
            query = get_db().collection(f"users/{user_id}/receipts")

            if supplier:
                query = query.where("supplier", "==", supplier)
            if category:
                query = query.where("category", "==", category)

            receipts = []
            for doc in query.stream():
                data = doc.to_dict()
                data["id"] = doc.id

                # Date filtering (client-side for now, move to backend when migrating)
                if date_from and date_to:
                    doc_date = data.get("receiptDate", "")
                    if date_from <= doc_date <= date_to:
                        receipts.append(data)
                else:
                    receipts.append(data)

            return receipts

        except Exception as e:
            logger.error(f"Failed to search receipts: {e}")
            raise


    @staticmethod
    async def check_duplicate(
        user_id: str,
        supplier: Optional[str] = None,
        totalAmount: Optional[str] = None,
        receiptDate: Optional[str] = None,
        invoiceNumber: Optional[str] = None,
        exclude_id: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        try:
            receipts = get_db().collection(f"users/{user_id}/receipts")
            matches = []

            if invoiceNumber:
                inv_matches = list(receipts.where("invoiceNumber", "==", invoiceNumber).stream())
                for doc in inv_matches:
                    data = doc.to_dict()
                    data["id"] = doc.id
                    if exclude_id and data["id"] == exclude_id:
                        continue
                    data["_confidence"] = "high"
                    matches.append(data)

            if supplier:
                sup_matches = list(receipts.where("supplier", "==", supplier).stream())
                for doc in sup_matches:
                    data = doc.to_dict()
                    data["id"] = doc.id
                    if exclude_id and data["id"] == exclude_id:
                        continue
                    if any(m["id"] == data["id"] for m in matches):
                        continue
                    if totalAmount and receiptDate:
                        if data.get("totalAmount") == totalAmount and data.get("receiptDate") == receiptDate:
                            data["_confidence"] = "high"
                        else:
                            data["_confidence"] = "medium"
                    else:
                        data["_confidence"] = "medium"
                    matches.append(data)

            return matches

        except Exception as e:
            logger.error(f"Failed to check duplicates: {e}")
            raise


class StorageService:
    """Wrapper for Firebase Storage operations."""

    @staticmethod
    def _upload_blob(blob_path: str, data: bytes) -> str:
        blob = get_bucket().blob(blob_path)
        blob.upload_from_string(data)
        blob.make_public()
        logger.info(f"Uploaded {blob_path} ({len(data)//1024} KB)")
        return blob.public_url

    @staticmethod
    async def upload_receipt_image(user_id: str, file_name: str, file_data: bytes) -> str:
        """Upload receipt image, return public URL."""
        try:
            return StorageService._upload_blob(f"receipts/{user_id}/{file_name}", file_data)
        except Exception as e:
            logger.error(f"Failed to upload image: {e}")
            raise

    @staticmethod
    async def upload_receipt_images(
        user_id: str, base_name: str, full_data: bytes, thumb_data: bytes | None = None,
    ) -> tuple[str, str | None]:
        """
        Upload full image + optional thumbnail, returning (image_url, thumbnail_url).
        """
        try:
            image_url = StorageService._upload_blob(
                f"receipts/{user_id}/{base_name}.jpg", full_data,
            )
            thumb_url = None
            if thumb_data:
                thumb_url = StorageService._upload_blob(
                    f"receipts/{user_id}/{base_name}_thumb.jpg", thumb_data,
                )
            return image_url, thumb_url
        except Exception as e:
            logger.error(f"Failed to upload images: {e}")
            raise

    @staticmethod
    async def delete_receipt_image(image_url: str) -> bool:
        """Delete image from Firebase Storage."""
        try:
            # Extract path from URL
            # URL format: https://storage.googleapis.com/bucket/path
            if "receipts/" in image_url:
                path = image_url.split("receipts/", 1)[1].split("?")[0]
                blob = get_bucket().blob(f"receipts/{path}")
                blob.delete()

                logger.info(f"Deleted image from storage")
                return True

            return False

        except Exception as e:
            logger.error(f"Failed to delete image: {e}")
            raise
