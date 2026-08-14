#!/usr/bin/env python3
"""
Reclaim pre-auth-migration data for an existing account.

Before AUTH_MODE=local, rows were keyed by Firebase uids. Local auth creates
brand-new uids in `users`. This script re-points an old uid's rows to a new
local uid so the person sees all their historical data (receipts, images,
audit trail, scan errors, AI settings, review batches) after logging in.

Images are stored flat (named by receipt_id), so no files need to move.

Usage (run inside the backend container):
    python scripts/rekey_user.py --old-uid <firebase_uid> --new-uid <local_uid>

Both uids must differ. The new uid must already exist in `users` (create it
via the Admin UI or `scripts/create_user.py` first). The old uid's rows are
REASSIGNED (the old uid is left with nothing), so back up first if unsure.

Tables re-keyed in Postgres: receipts, tasks, scan_errors, audit_logs,
review_batches, user_ai_settings. Also re-keys the SQLite review-batch store
(REVIEW_BATCH_DB_PATH) if present.

Backup archives under BACKUP_STORAGE_DIR are not relabelled (they embed the
old uid inside the tar). Export a fresh backup after re-keying to capture the
recovered data in an archive the user can see.
"""

import argparse
import asyncio
import os
import sqlite3
import sys


def parse_args():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--old-uid", required=True, help="existing uid to reclaim (usually a Firebase uid)")
    p.add_argument("--new-uid", required=True, help="local users.uid to assign the data to")
    return p.parse_args()


def _postgres_tables():
    return [
        "receipts",
        "tasks",
        "scan_errors",
        "audit_logs",
        "review_batches",
        "user_ai_settings",
    ]


async def _rekey_postgres(dsn: str, old_uid: str, new_uid: str) -> None:
    import asyncpg

    conn = await asyncpg.connect(dsn)
    try:
        exists = await conn.fetchval("SELECT 1 FROM users WHERE uid = $1", new_uid)
        if not exists:
            raise SystemExit(
                f"new-uid {new_uid} does not exist in users. "
                "Create the account first (Admin UI or scripts/create_user.py)."
            )
        print(f"Re-keying Postgres: {old_uid} -> {new_uid}")
        for table in _postgres_tables():
            try:
                count = await conn.fetchval(
                    f"UPDATE {table} SET user_id = $1 WHERE user_id = $2",
                    new_uid, old_uid,
                )
                print(f"  {table}: {count} row(s)")
            except asyncpg.UndefinedTableError:
                print(f"  {table}: table not present, skipped")
    finally:
        await conn.close()


def _rekey_sqlite_review_batches(path: str, old_uid: str, new_uid: str) -> None:
    if not path or not os.path.isfile(path):
        print("SQLite review-batch store not found — skipped")
        return
    db = sqlite3.connect(path)
    try:
        cur = db.execute(
            "UPDATE review_batches SET user_id = ? WHERE user_id = ?",
            (new_uid, old_uid),
        )
        db.commit()
        print(f"SQLite review_batches: {cur.rowcount} row(s)")
    finally:
        db.close()


def main() -> None:
    args = parse_args()
    old_uid = args.old_uid.strip()
    new_uid = args.new_uid.strip()
    if old_uid == new_uid:
        raise SystemExit("--old-uid and --new-uid must be different")
    if not old_uid or not new_uid:
        raise SystemExit("--old-uid and --new-uid are required")

    dsn = os.environ.get("DATABASE_URL")
    if not dsn:
        raise SystemExit("DATABASE_URL is not set")

    asyncio.run(_rekey_postgres(dsn, old_uid, new_uid))
    _rekey_sqlite_review_batches(
        os.environ.get("REVIEW_BATCH_DB_PATH"), old_uid, new_uid
    )
    print("Done.")


if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        print(e, file=sys.stderr)
        sys.exit(1)
