"""
SQLite-backed review batch service.

Tracks which receipts are in a review batch and their per-receipt review
status.  The actual receipt data lives in Firestore — this is only a
lightweight overlay for the manual-review workflow.
"""

import sqlite3
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)

# Resolve DB path once at module load.
# Priority: REVIEW_BATCH_DB_PATH env var -> settings override -> default relative path
_default = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "review_batches.db")
DB_PATH = os.environ.get("REVIEW_BATCH_DB_PATH") or _default

# Allow settings-based override (handles Docker env var -> settings -> here)
try:
    from app.core.config import settings
    if settings.REVIEW_BATCH_DB_PATH:
        DB_PATH = settings.REVIEW_BATCH_DB_PATH
except Exception:
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    """Create tables if they don't exist. Safe to call on every startup."""
    conn = _get_conn()
    try:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS review_batches (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                name TEXT NOT NULL,
                csv_filename TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS review_batch_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                batch_id TEXT NOT NULL,
                receipt_id TEXT NOT NULL,
                review_status TEXT NOT NULL DEFAULT 'pending_review',
                reviewer_notes TEXT,
                reviewed_at TEXT,
                FOREIGN KEY (batch_id) REFERENCES review_batches(id) ON DELETE CASCADE,
                UNIQUE(batch_id, receipt_id)
            );
        """)
        conn.commit()
        logger.info(f"Review batch DB initialized at {DB_PATH}")
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Batch CRUD
# ---------------------------------------------------------------------------

def create_batch(user_id: str, name: str, receipt_ids: list[str], csv_filename: Optional[str] = None) -> dict:
    """Create a new review batch with the given receipt IDs."""
    batch_id = uuid.uuid4().hex[:12]
    now = _now()
    conn = _get_conn()
    try:
        conn.execute(
            "INSERT INTO review_batches (id, user_id, name, csv_filename, created_at, updated_at) VALUES (?,?,?,?,?,?)",
            (batch_id, user_id, name, csv_filename, now, now),
        )
        for rid in receipt_ids:
            try:
                conn.execute(
                    "INSERT INTO review_batch_items (batch_id, receipt_id, review_status) VALUES (?,?,?)",
                    (batch_id, rid.strip(), "pending_review"),
                )
            except sqlite3.IntegrityError:
                pass  # duplicate receipt_id in same batch — skip
        conn.commit()
        return {"id": batch_id, "user_id": user_id, "name": name, "csv_filename": csv_filename,
                "receipt_count": len(receipt_ids), "created_at": now, "updated_at": now}
    finally:
        conn.close()


def list_batches(user_id: str) -> list[dict]:
    """List all review batches for a user with item counts by status."""
    conn = _get_conn()
    try:
        rows = conn.execute(
            "SELECT * FROM review_batches WHERE user_id = ? ORDER BY created_at DESC",
            (user_id,),
        ).fetchall()

        batches = []
        for r in rows:
            b = dict(r)
            stats = conn.execute(
                "SELECT review_status, COUNT(*) as cnt FROM review_batch_items WHERE batch_id = ? GROUP BY review_status",
                (b["id"],),
            ).fetchall()
            b["status_counts"] = {s["review_status"]: s["cnt"] for s in stats}
            b["total_items"] = sum(b["status_counts"].values())
            batches.append(b)
        return batches
    finally:
        conn.close()


def get_batch(user_id: str, batch_id: str) -> Optional[dict]:
    """Get a single batch with its items."""
    conn = _get_conn()
    try:
        row = conn.execute(
            "SELECT * FROM review_batches WHERE id = ? AND user_id = ?",
            (batch_id, user_id),
        ).fetchone()
        if not row:
            return None
        b = dict(row)
        items = conn.execute(
            "SELECT * FROM review_batch_items WHERE batch_id = ? ORDER BY id",
            (batch_id,),
        ).fetchall()
        b["items"] = [dict(i) for i in items]
        return b
    finally:
        conn.close()


def delete_batch(user_id: str, batch_id: str) -> bool:
    """Delete a batch and its items. Returns True if found and deleted."""
    conn = _get_conn()
    try:
        cur = conn.execute(
            "DELETE FROM review_batches WHERE id = ? AND user_id = ?",
            (batch_id, user_id),
        )
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Per-item review status
# ---------------------------------------------------------------------------

def update_item_status(batch_id: str, receipt_id: str, review_status: str, notes: Optional[str] = None) -> Optional[dict]:
    """Update the review status of a single receipt in a batch."""
    conn = _get_conn()
    try:
        now = _now() if review_status == "reviewed" else None
        conn.execute(
            "UPDATE review_batch_items SET review_status = ?, reviewer_notes = ?, reviewed_at = COALESCE(?, reviewed_at) WHERE batch_id = ? AND receipt_id = ?",
            (review_status, notes, now, batch_id, receipt_id),
        )
        # touch batch updated_at
        conn.execute(
            "UPDATE review_batches SET updated_at = ? WHERE id = ?",
            (_now(), batch_id),
        )
        conn.commit()
        row = conn.execute(
            "SELECT * FROM review_batch_items WHERE batch_id = ? AND receipt_id = ?",
            (batch_id, receipt_id),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def delete_item(batch_id: str, receipt_id: str) -> bool:
    """Remove a single receipt from a batch. Returns True if found and deleted."""
    conn = _get_conn()
    try:
        cur = conn.execute(
            "DELETE FROM review_batch_items WHERE batch_id = ? AND receipt_id = ?",
            (batch_id, receipt_id),
        )
        conn.execute("UPDATE review_batches SET updated_at = ? WHERE id = ?", (_now(), batch_id))
        conn.commit()
        return cur.rowcount > 0
    finally:
        conn.close()


def get_item_status(batch_id: str, receipt_id: str) -> Optional[dict]:
    conn = _get_conn()
    try:
        row = conn.execute(
            "SELECT * FROM review_batch_items WHERE batch_id = ? AND receipt_id = ?",
            (batch_id, receipt_id),
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()
