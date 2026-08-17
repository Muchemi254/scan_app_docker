"""
Local authentication service (AUTH_MODE=local).

Backs the offline signup/login flow with:
- A Postgres `users` table (email + bcrypt password hash)
- Short-lived-ish local JWTs signed with SECRET_KEY
- Admin bootstrap from ADMIN_EMAIL/ADMIN_PASSWORD env (or generated)

The `uid` produced here is the same opaque string identity used across
all tenant tables (receipts.user_id, tasks.user_id, ...) and feeds
Postgres Row-Level Security via set_current_user_id().
"""

import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

import asyncpg
import bcrypt
from jose import jwt, JWTError

from app.core.config import settings

logger = logging.getLogger(__name__)

# bcrypt only uses the first 72 bytes of a password
_BCRYPT_MAX_BYTES = 72


def _bcrypt_bytes(password: str) -> bytes:
    return password.encode("utf-8")[:_BCRYPT_MAX_BYTES]


def hash_password(password: str) -> str:
    """Hash a password with bcrypt. Returns the encoded hash string."""
    return bcrypt.hashpw(_bcrypt_bytes(password), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    """Verify a password against a bcrypt hash. Returns False on any mismatch."""
    try:
        return bcrypt.checkpw(_bcrypt_bytes(password), password_hash.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def create_access_token(uid: str) -> str:
    """Create a signed local JWT whose subject is the user's uid."""
    expire = datetime.now(timezone.utc) + timedelta(days=settings.JWT_EXPIRE_DAYS)
    payload = {"sub": uid, "exp": expire, "iss": "scanapp-local"}
    return jwt.encode(payload, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def decode_access_token(token: str) -> str:
    """Decode + verify a local JWT. Returns the uid. Raises ValueError on failure."""
    try:
        claims = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    except JWTError as e:
        raise ValueError("Invalid authentication token") from e
    uid = claims.get("sub")
    if not uid:
        raise ValueError("Token missing subject")
    return uid


def _generate_uid() -> str:
    """28-char url-safe uid, shaped like the Firebase-style ids already in use."""
    return secrets.token_urlsafe(21)


def _generate_password() -> str:
    return secrets.token_urlsafe(12)


def user_public_dict(user: dict) -> dict:
    """Strip credentials before returning user data to callers."""
    return {
        "uid": user["uid"],
        "email": user["email"],
        "is_admin": bool(user["is_admin"]),
        "display_name": user.get("display_name"),
        "created_at": user.get("created_at"),
    }


def _user_row(row) -> Optional[dict]:
    if not row:
        return None
    return dict(row)


# ═══════════════════════════════════════════════════════════════════════════
# User store (Postgres, bypasses RLS by design)
# ═══════════════════════════════════════════════════════════════════════════

async def get_user_by_uid(uid: str) -> Optional[dict]:
    from app.core.database import get_pool
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT uid, email, password_hash, is_admin, display_name, created_at
            FROM users WHERE uid = $1
            """,
            uid,
        )
        return _user_row(row)


async def get_user_by_email(email: str) -> Optional[dict]:
    from app.core.database import get_pool
    pool = await get_pool()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT uid, email, password_hash, is_admin, display_name, created_at
            FROM users WHERE lower(email) = lower($1)
            """,
            email,
        )
        return _user_row(row)


async def create_user(
    email: str,
    password: str,
    is_admin: bool = False,
    uid: Optional[str] = None,
    display_name: Optional[str] = None,
) -> Optional[dict]:
    """
    Create a local user. Returns the user dict, or None if the email is taken.
    """
    from app.core.database import get_pool
    email_norm = email.strip().lower()
    uid = uid or _generate_uid()
    pw_hash = hash_password(password)
    pool = await get_pool()
    async with pool.acquire() as conn:
        try:
            await conn.execute(
                """
                INSERT INTO users (uid, email, password_hash, is_admin, display_name)
                VALUES ($1, $2, $3, $4, $5)
                """,
                uid, email_norm, pw_hash, is_admin, display_name,
            )
        except asyncpg.UniqueViolationError:
            return None
    return await get_user_by_uid(uid)


async def authenticate_user(email: str, password: str) -> Optional[dict]:
    """Return the user dict if credentials are valid, else None."""
    user = await get_user_by_email(email)
    if not user:
        return None
    if not verify_password(password, user["password_hash"]):
        return None
    return user


async def list_users() -> list[dict]:
    """List all users without credential fields, newest first."""
    from app.core.database import get_pool
    pool = await get_pool()
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT uid, email, is_admin, display_name, created_at
            FROM users ORDER BY created_at DESC
            """
        )
        return [dict(r) for r in rows]


async def delete_user(uid: str) -> dict:
    """Delete a user row (FK CASCADE removes backups + preferences rows).

    Returns ``{"deleted": bool, "backup_ids": [...]}`` — the backup tarball
    ids are captured *before* the cascade so the background file cleanup can
    remove them right away (their rows are gone, so the orphan-file sweep
    alone would wait out the age guard first).
    """
    from app.core.database import get_pool
    pool = await get_pool()
    async with pool.acquire() as conn:
        backup_ids = [
            str(r["id"])
            for r in await conn.fetch(
                "SELECT id FROM backups WHERE user_id = $1", uid
            )
        ]
        await conn.execute(
            "DELETE FROM conversations WHERE user_a = $1 OR user_b = $1", uid
        )
        result = await conn.execute("DELETE FROM users WHERE uid = $1", uid)
        return {"deleted": result == "DELETE 1", "backup_ids": backup_ids}


async def count_admin_users() -> int:
    from app.core.database import get_pool
    pool = await get_pool()
    async with pool.acquire() as conn:
        return await conn.fetchval(
            "SELECT COUNT(*) FROM users WHERE is_admin = true"
        )


async def bootstrap_admin() -> dict:
    """
    Ensure a bootstrap admin exists in local mode. Called once at startup.
    Uses ADMIN_EMAIL/ADMIN_PASSWORD if set, otherwise generates credentials
    and logs them (first boot only).
    """
    email = (settings.ADMIN_EMAIL or "admin@local").strip().lower()

    existing = await get_user_by_email(email)
    if existing:
        return existing

    password = settings.ADMIN_PASSWORD or _generate_password()
    user = await create_user(email, password, is_admin=True)
    if user is None:
        # Race: another boot created it concurrently
        return await get_user_by_email(email)

    logger.warning(
        "Bootstrap admin created — email=%s password=%s "
        "(set ADMIN_EMAIL/ADMIN_PASSWORD env to control this)",
        email, password,
    )
    return user
