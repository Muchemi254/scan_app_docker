"""
Firestore → PostgreSQL data migration (one-shot).

Requirements: firebase-admin, asyncpg, Firebase credentials, PostgreSQL running.

Usage:
    cd backend
    FIREBASE_CREDENTIALS_PATH=./firebaseservice.json \
    DATABASE_URL=postgresql://scanapp:scanapp_dev@localhost:5432/scanapp \
    python scripts/migrate_data.py
"""
import asyncio
import json
import os
import sys
import re
from datetime import datetime, date
from decimal import Decimal

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import asyncpg
import firebase_admin
from firebase_admin import credentials, firestore

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://scanapp:scanapp_dev@localhost:5432/scanapp")
FIREBASE_CREDS = os.getenv("FIREBASE_CREDENTIALS_PATH", "../firebaseservice.json")
BATCH_SIZE = 200


# ── helpers ──────────────────────────────────────────────────────────────────

def sanitize_num(v):
    if v is None: return 0.0
    if isinstance(v, (int, float, Decimal)): return float(v)
    try: return float(re.sub(r"[^0-9.\-]", "", str(v)))
    except ValueError: return 0.0

def parse_date(s):
    if not s: return None
    try:
        parts = s.strip().split("/")
        if len(parts) == 3:
            return date(int(parts[2]), int(parts[0]), int(parts[1]))
    except (ValueError, TypeError): pass
    try: return date.fromisoformat(s.strip())
    except (ValueError, TypeError): return None

def dt_or_none(val):
    if val is None: return None
    if isinstance(val, datetime): return val
    try: return datetime.fromisoformat(str(val))
    except: return None

stats = {"receipts": 0, "items": 0, "tasks": 0, "settings": 0, "skipped": 0, "errors": 0}


# ── migrate receipts + line_items ────────────────────────────────────────────

async def migrate_receipts(pool, db):
    print("\n=== Migrating receipts ===")
    users_coll = db.collection("users")
    user_docs = list(users_coll.stream())

    for user_doc in user_docs:
        uid = user_doc.id
        receipts_coll = user_doc.reference.collection("receipts")
        docs = list(receipts_coll.stream())

        if not docs:
            continue

        print(f"  User {uid}: {len(docs)} receipts")
        local_count = 0

        for i in range(0, len(docs), BATCH_SIZE):
            batch = docs[i:i + BATCH_SIZE]
            async with pool.acquire() as conn:
                async with conn.transaction():
                    for doc in batch:
                        try:
                            d = doc.to_dict()
                            rid = doc.id
                            receipt_date = parse_date(d.get("receiptDate")) or date.today()
                            total = sanitize_num(d.get("totalAmount"))
                            tax = sanitize_num(d.get("taxAmount")) if d.get("taxAmount") else None
                            legacy_url = d.get("imageUrl") or None

                            created = dt_or_none(d.get("createdAt"))
                            updated = dt_or_none(d.get("updatedAt"))
                            scanned = dt_or_none(d.get("scannedAt"))

                            await conn.execute("""
                                INSERT INTO receipts (id, user_id, status, supplier, total_amount,
                                    tax_amount, receipt_date, category, invoice_number, kra_pin,
                                    cu_invoice, batch_title, legacy_image_url,
                                    scanned_at, created_at, updated_at)
                                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                                        $10, $11, $12, $13, $14, $15, $16)
                                ON CONFLICT (id) DO NOTHING
                            """, rid, uid,
                                d.get("status", "processed"),
                                d.get("supplier", ""),
                                Decimal(str(total)),
                                Decimal(str(tax)) if tax else None,
                                receipt_date,
                                d.get("category"),
                                d.get("invoiceNumber"),
                                d.get("kraPin"),
                                d.get("cuInvoice"),
                                d.get("batchTitle"),
                                legacy_url,
                                scanned, created, updated,
                            )

                            # Line items
                            items = d.get("items") or []
                            for idx, item in enumerate(items):
                                try:
                                    await conn.execute("""
                                        INSERT INTO line_items (receipt_id, sort_order, name,
                                            quantity, price, tax, is_zero_rated, discount)
                                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                                    """, rid, idx,
                                        item.get("name", "N/A"),
                                        float(item.get("quantity", 1)),
                                        sanitize_num(item.get("price", "0")),
                                        sanitize_num(item.get("tax", "0")),
                                        item.get("isZeroRated", False),
                                        Decimal(str(sanitize_num(item.get("discount"))))
                                            if item.get("discount") else None,
                                    )
                                    stats["items"] += 1
                                except Exception as e:
                                    stats["errors"] += 1
                                    print(f"    WARN: item skipped for {rid[:12]}: {e}")

                            stats["receipts"] += 1
                            local_count += 1
                        except Exception as e:
                            stats["errors"] += 1
                            print(f"    ERROR: {doc.id[:12]} — {e}")

        print(f"    Migrated {local_count} receipts")


# ── migrate tasks ────────────────────────────────────────────────────────────

async def migrate_tasks(pool, db):
    print("\n=== Migrating tasks ===")
    users_coll = db.collection("users")

    for user_doc in users_coll.stream():
        uid = user_doc.id
        tasks_coll = user_doc.reference.collection("tasks")
        docs = list(tasks_coll.stream())

        if not docs:
            continue

        print(f"  User {uid}: {len(docs)} tasks")
        async with pool.acquire() as conn:
            async with conn.transaction():
                for doc in docs:
                    try:
                        d = doc.to_dict()
                        tid = d.get("id") or doc.id
                        await conn.execute("""
                            INSERT INTO tasks (id, user_id, task_type, batch_title, status,
                                total_items, completed_items, current_step, total_steps,
                                percentage, message, error, metadata, results,
                                created_at, updated_at, started_at, completed_at)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                                    $11, $12, $13::jsonb, $14::jsonb, $15, $16, $17, $18)
                            ON CONFLICT (id) DO NOTHING
                        """, tid, uid,
                            d.get("task_type", "scan_batch"),
                            d.get("batch_title", ""),
                            d.get("status", "queued"),
                            d.get("total_items", 0),
                            d.get("completed_items", 0),
                            d.get("current_step", 0),
                            d.get("total_steps", 0),
                            d.get("percentage", 0),
                            d.get("message", ""),
                            d.get("error"),
                            json.dumps(d.get("metadata") or {}),
                            json.dumps(d.get("results") or {}),
                            dt_or_none(d.get("created_at")),
                            dt_or_none(d.get("updated_at")),
                            dt_or_none(d.get("started_at")),
                            dt_or_none(d.get("completed_at")),
                        )
                        stats["tasks"] += 1
                    except Exception as e:
                        stats["errors"] += 1
                        print(f"    ERROR task {doc.id[:12]}: {e}")


# ── migrate AI settings ──────────────────────────────────────────────────────

async def migrate_settings(pool, db):
    print("\n=== Migrating AI settings ===")
    users_coll = db.collection("users")

    for user_doc in users_coll.stream():
        uid = user_doc.id
        settings_coll = user_doc.reference.collection("settings")
        docs = list(settings_coll.stream())

        for doc in docs:
            if doc.id != "ai_config":
                continue
            try:
                d = doc.to_dict()
                async with pool.acquire() as conn:
                    await conn.execute("""
                        INSERT INTO user_ai_settings (user_id, provider, model_id, configs)
                        VALUES ($1, $2, $3, $4::jsonb)
                        ON CONFLICT (user_id) DO UPDATE
                        SET provider = $2, model_id = $3, configs = $4::jsonb
                    """, uid,
                        d.get("provider", "gemini"),
                        d.get("model_id", "gemini-3-flash-preview"),
                        json.dumps(d.get("configs", {})),
                    )
                stats["settings"] += 1
            except Exception as e:
                stats["errors"] += 1
                print(f"    ERROR settings {uid}: {e}")

    if stats["settings"] == 0:
        print("  No ai_config documents found")


# ── verification ─────────────────────────────────────────────────────────────

async def verify(pool):
    print("\n=== Verification ===")
    async with pool.acquire() as conn:
        r = await conn.fetchrow("SELECT COUNT(*) as cnt FROM receipts")
        i = await conn.fetchrow("SELECT COUNT(*) as cnt FROM line_items")
        t = await conn.fetchrow("SELECT COUNT(*) as cnt FROM tasks")
        s = await conn.fetchrow("SELECT COUNT(*) as cnt FROM user_ai_settings")
        print(f"  receipts:      {r['cnt']}")
        print(f"  line_items:    {i['cnt']}")
        print(f"  tasks:         {t['cnt']}")
        print(f"  ai_settings:   {s['cnt']}")


# ── main ─────────────────────────────────────────────────────────────────────

async def main():
    print(f"Firestore: {FIREBASE_CREDS}")
    print(f"PostgreSQL: {DATABASE_URL}")

    if not firebase_admin._apps:
        cred = credentials.Certificate(FIREBASE_CREDS)
        firebase_admin.initialize_app(cred)
    db = firestore.client()
    pool = await asyncpg.create_pool(DATABASE_URL, min_size=2, max_size=5)

    try:
        await migrate_receipts(pool, db)
        await migrate_tasks(pool, db)
        await migrate_settings(pool, db)
        await verify(pool)

        print(f"\n{'=' * 50}")
        print(f"TOTALS: {stats['receipts']} receipts, {stats['items']} items, "
              f"{stats['tasks']} tasks, {stats['settings']} settings")
        if stats["errors"]:
            print(f"ERRORS: {stats['errors']}")
        print(f"{'=' * 50}")
    finally:
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
