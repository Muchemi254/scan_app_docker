"""Add DB-backed backup metadata table.

Backup metadata previously lived in a shared flat JSON file
(backup_history.json) beside the archives — fragile, racy on concurrent
exports, and a single point of loss. This revision creates a `backups`
table and backfills it from any legacy history file still present, so
existing backups keep working and downloads work from any device.

Quotas/retention are NOT enforced here — that happens at export time using
admin-tunable settings (see backup service / Admin UI).

Revision ID: 012
Revises: 011
"""
import json
import logging
import os
from datetime import datetime as dt
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

logger = logging.getLogger(__name__)

revision: str = "012"
down_revision: Union[str, None] = "011"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "backups",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("user_id", sa.Text(), nullable=False),
        sa.Column("filename", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False, server_default="0"),
    )
    op.create_foreign_key(
        "fk_backups_uid", "backups", "users", ["user_id"], ["uid"],
        ondelete="CASCADE",
    )
    op.create_index("ix_backups_user_created", "backups", ["user_id", "created_at"])

    _backfill_legacy_history()


def downgrade() -> None:
    op.drop_index("ix_backups_user_created", table_name="backups")
    op.drop_table("backups")


def _backfill_legacy_history() -> None:
    """One-time import of the old backup_history.json into the table.

    Only imports entries whose user still exists (the backups FK to users
    would otherwise fail) and whose timestamp parses — a single bad row must
    not abort the whole backfill.
    """
    storage_dir = os.environ.get("BACKUP_STORAGE_DIR", "/app/backups")
    legacy_path = os.path.join(storage_dir, "backup_history.json")
    if not os.path.exists(legacy_path):
        return

    try:
        with open(legacy_path, "r") as f:
            entries = json.load(f)
        if not isinstance(entries, list):
            logger.warning("Legacy backup history is not a list; skipping backfill")
            return

        bind = op.get_bind()
        existing_uids = set(
            r[0]
            for r in bind.execute(sa.text("SELECT uid FROM users")).fetchall()
        )

        rows = []
        for e in entries:
            user_id = str(e.get("user_id", ""))
            if user_id not in existing_uids:
                logger.warning("Skipping legacy backup %s for deleted user %s",
                               e.get("id"), user_id[:12])
                continue
            try:
                created_at = e.get("created_at")
                if created_at:
                    # asyncpg requires real datetime objects, not strings.
                    created_at = dt.fromisoformat(
                        str(created_at).replace("Z", "+00:00")
                    )
                rows.append({
                    "id": str(e.get("id", "")),
                    "user_id": user_id,
                    "filename": str(e.get("filename", "")),
                    "created_at": created_at,
                    "size_bytes": int(e.get("size_bytes", 0) or 0),
                })
            except (TypeError, ValueError):
                logger.warning("Skipping malformed legacy backup entry: %r", e.get("id"))

        if not rows:
            logger.info("No importable legacy backup records to backfill")
            return

        inserted = 0
        for row in rows:
            try:
                bind.execute(
                    sa.text(
                        """
                        INSERT INTO backups (id, user_id, filename, created_at, size_bytes)
                        VALUES (:id, :user_id, :filename, COALESCE(:created_at, now()), :size_bytes)
                        ON CONFLICT (id) DO NOTHING
                        """
                    ),
                    row,
                )
                inserted += 1
            except Exception:
                logger.warning("Skipping unimportable legacy backup %s", row["id"],
                               exc_info=True)
        logger.info("Backfilled %d/%d legacy backup records into `backups`",
                    inserted, len(rows))
    except Exception:
        logger.warning("Could not backfill legacy backup history from %s", legacy_path,
                       exc_info=True)