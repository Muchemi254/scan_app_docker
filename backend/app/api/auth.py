"""
Local authentication endpoints (AUTH_MODE=local).

POST   /api/v1/auth/login         Public — email + password → access token
GET    /api/v1/auth/me            Authed — session hydration / current user
POST   /api/v1/auth/admin/users   Admin  — create a user
GET    /api/v1/auth/admin/users   Admin  — list users
DELETE /api/v1/auth/admin/users/{uid}  Admin  — delete a user

Signup is intentionally closed: accounts are created by an administrator
(the frontend shows a "contact your administrator" page instead).
"""

import logging
import asyncio
from typing import Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.core.security import get_current_user_id
from app.core.config import settings
from app.services import auth_service
from app.core import trusted_hosts
from app.services import app_settings_service
from app.services import admin_keys_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])


# ═══════════════════════════════════════════════════════════════════════════
# Schemas
# ═══════════════════════════════════════════════════════════════════════════

class UserOut(BaseModel):
    uid: str
    email: str
    is_admin: bool
    display_name: Optional[str] = None
    created_at: Optional[str] = None


class LoginRequest(BaseModel):
    email: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class AdminCreateUserRequest(BaseModel):
    email: str
    password: str
    is_admin: bool = False
    display_name: Optional[str] = None


class AdminUserOut(BaseModel):
    uid: str
    email: str
    is_admin: bool
    display_name: Optional[str] = None
    created_at: Optional[str] = None


class TrustedHostsRequest(BaseModel):
    hosts: List[str] = []


class TrustedHostsResponse(BaseModel):
    hosts: List[str]


class AdminAIProviderConfig(BaseModel):
    api_key: Optional[str] = None
    enabled: bool = True
    model_id: Optional[str] = None
    thinking_mode: bool = False


class AdminAIProvidersRequest(BaseModel):
    providers: Dict[str, AdminAIProviderConfig] = {}


class AdminAIProvidersResponse(BaseModel):
    providers: Dict[str, AdminAIProviderConfig]


class AdminAIProviderTestRequest(BaseModel):
    provider: str = "gemini"
    model_id: Optional[str] = None


class AdminAIProviderTestResponse(BaseModel):
    success: bool
    message: str


def _public_user(user: dict) -> UserOut:
    d = auth_service.user_public_dict(user)
    return UserOut(
        uid=d["uid"],
        email=d["email"],
        is_admin=d["is_admin"],
        display_name=d.get("display_name"),
        created_at=d.get("created_at").isoformat() if d.get("created_at") else None,
    )


async def require_admin(user_id: str = Depends(get_current_user_id)) -> str:
    """Dependency: authenticated AND is_admin."""
    user = await auth_service.get_user_by_uid(user_id)
    if not user or not user["is_admin"]:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin privileges required",
        )
    return user_id


# ═══════════════════════════════════════════════════════════════════════════
# Public auth
# ═══════════════════════════════════════════════════════════════════════════

@router.post("/login", response_model=TokenResponse)
async def login(body: LoginRequest):
    """Exchange email + password for a local access token."""
    user = await auth_service.authenticate_user(body.email, body.password)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )
    token = auth_service.create_access_token(user["uid"])
    return TokenResponse(access_token=token, user=_public_user(user))


@router.get("/me", response_model=UserOut)
async def me(user_id: str = Depends(get_current_user_id)):
    """Return the current authenticated user. 401 if the user no longer exists."""
    user = await auth_service.get_user_by_uid(user_id)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User no longer exists",
        )
    return _public_user(user)


# ═══════════════════════════════════════════════════════════════════════════
# Admin — user management
# ═══════════════════════════════════════════════════════════════════════════

@router.post("/admin/users", response_model=AdminUserOut, status_code=status.HTTP_201_CREATED)
async def admin_create_user(body: AdminCreateUserRequest, _admin_uid: str = Depends(require_admin)):
    """Create a new user account (admin only)."""
    if not body.email.strip() or not body.password:
        raise HTTPException(status_code=422, detail="email and password are required")

    user = await auth_service.create_user(
        body.email,
        body.password,
        is_admin=body.is_admin,
        display_name=body.display_name,
    )
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A user with that email already exists",
        )
    return AdminUserOut(
        uid=user["uid"],
        email=user["email"],
        is_admin=bool(user["is_admin"]),
        display_name=user.get("display_name"),
        created_at=user["created_at"].isoformat() if user.get("created_at") else None,
    )


@router.get("/admin/users", response_model=List[AdminUserOut])
async def admin_list_users(_admin_uid: str = Depends(require_admin)):
    """List all users (admin only)."""
    users = await auth_service.list_users()
    return [
        AdminUserOut(
            uid=u["uid"],
            email=u["email"],
            is_admin=bool(u["is_admin"]),
            display_name=u.get("display_name"),
            created_at=u["created_at"].isoformat() if u.get("created_at") else None,
        )
        for u in users
    ]


@router.delete("/admin/users/{uid}", status_code=status.HTTP_204_NO_CONTENT)
async def admin_delete_user(uid: str, admin_uid: str = Depends(require_admin)):
    """Delete a user (admin only). Guarded against deleting yourself or the last admin."""
    if uid == admin_uid:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You cannot delete your own account",
        )

    target = await auth_service.get_user_by_uid(uid)
    if not target:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    if target["is_admin"] and await auth_service.count_admin_users() <= 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot delete the last admin account",
        )

    deleted = await auth_service.delete_user(uid)
    if not deleted["deleted"]:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="User not found")

    # Purge the user's remaining data (receipts, sessions, files, …) in the
    # background — the delete response must not block on that I/O. A periodic
    # sweep in the app lifecycle is the safety net if this task were to fail.
    if settings.SCHEDULE_DELETE_CLEANUP:
        try:
            from app.services import data_cleanup_service
            asyncio.create_task(
                data_cleanup_service.force_user_cleanup(
                    uid, backup_ids=deleted.get("backup_ids", [])
                )
            )
        except Exception as e:
            logger.warning(f"Failed to schedule cleanup for deleted user {uid}: {e}")

    return None


@router.get("/admin/settings/trusted-hosts", response_model=TrustedHostsResponse)
async def admin_get_trusted_hosts(_admin_uid: str = Depends(require_admin)):
    """Return the current trusted-hosts whitelist (admin only)."""
    return TrustedHostsResponse(hosts=trusted_hosts.get_allowed_hosts())


@router.put("/admin/settings/trusted-hosts", response_model=TrustedHostsResponse)
async def admin_update_trusted_hosts(
    body: TrustedHostsRequest,
    _admin_uid: str = Depends(require_admin),
):
    """Replace the trusted-hosts whitelist. Persists to Postgres and applies immediately.

    Hosts are stored hostname-only (port stripped) and lower-cased; use "*" to
    allow any Host header (disables the check — useful for roaming laptops).
    """
    try:
        hosts = trusted_hosts.normalize(body.hosts)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    try:
        await app_settings_service.set_trusted_hosts(hosts)
    except Exception as e:
        logger.error("Failed to persist trusted hosts: %s", e)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to persist trusted hosts",
        )

    trusted_hosts.set_allowed_hosts(hosts)
    logger.info("Trusted hosts updated: %s", ", ".join(hosts) if hosts else "(empty)")
    return TrustedHostsResponse(hosts=trusted_hosts.get_allowed_hosts())


def _mask_api_key(key: str) -> Optional[str]:
    if not key:
        return None
    return "********" + key[-4:] if len(key) > 4 else "********"


def _providers_response(config: dict) -> Dict[str, AdminAIProviderConfig]:
    """Mask keys and ensure every implemented provider is represented."""
    providers: Dict[str, AdminAIProviderConfig] = {}
    for provider in admin_keys_service.ALL_PROVIDERS:
        cfg = config.get(provider) or {}
        providers[provider] = AdminAIProviderConfig(
            api_key=_mask_api_key(cfg.get("api_key", "")) if cfg.get("api_key") else None,
            enabled=cfg.get("enabled", True),
            model_id=cfg.get("model_id") or admin_keys_service.default_model_for(provider),
            thinking_mode=bool(cfg.get("thinking_mode", False)),
        )
    return providers


@router.get("/admin/settings/ai-providers", response_model=AdminAIProvidersResponse)
async def admin_get_ai_providers(_admin_uid: str = Depends(require_admin)):
    """Return admin-managed shared AI provider keys, masked (admin only).

    These are the fallback keys used by users who don't configure their own.
    No key is returned in plaintext.
    """
    config = await admin_keys_service.get_admin_provider_config()
    return AdminAIProvidersResponse(providers=_providers_response(config))


@router.put("/admin/settings/ai-providers", response_model=AdminAIProvidersResponse)
async def admin_update_ai_providers(
    body: AdminAIProvidersRequest,
    _admin_uid: str = Depends(require_admin),
):
    """Replace admin-managed shared AI provider keys (admin only).

    Rules per provider: a masked key (\"********…\") or omitted key keeps the
    existing value; an empty string clears it; otherwise the key is stored
    (encrypted). `enabled`, `model_id` and `thinking_mode` are saved as-is.
    Changes apply to all subsequent extractions immediately.

    Users who have their own key are unaffected — the admin key is only a
    fallback so users without credentials can still scan.
    """
    current = await admin_keys_service.get_admin_provider_config()

    for provider, item in body.providers.items():
        existing = current.get(provider, {
            "api_key": "",
            "enabled": True,
            "model_id": admin_keys_service.default_model_for(provider),
            "thinking_mode": False,
        })
        new_key = item.api_key
        if new_key is None or new_key.startswith("********"):
            api_key = existing.get("api_key", "")
        else:
            api_key = new_key
        current[provider] = {
            "api_key": api_key,
            "enabled": item.enabled,
            "model_id": item.model_id or admin_keys_service.default_model_for(provider),
            "thinking_mode": item.thinking_mode,
        }

    await admin_keys_service.set_admin_provider_config(current)
    saved = await admin_keys_service.get_admin_provider_config()
    logger.info("Admin AI provider keys updated: %s", ", ".join(sorted(body.providers)))
    return AdminAIProvidersResponse(providers=_providers_response(saved))


@router.post("/admin/settings/ai-providers/test", response_model=AdminAIProviderTestResponse)
async def admin_test_ai_provider(
    body: AdminAIProviderTestRequest,
    _admin_uid: str = Depends(require_admin),
):
    """Test the saved admin key for a provider (admin only).

    Resolves the raw stored key (masked values in the request are resolved
    against the stored key) and makes a single minimal call. The failure is
    also persisted to that admin's scan errors for later review.
    """
    from app.services.gemini import test_api_key

    if body.provider not in admin_keys_service.ALL_PROVIDERS:
        raise HTTPException(status_code=400, detail=f"Unsupported provider: {body.provider}")

    config = await admin_keys_service.get_admin_provider_config()
    cfg = config.get(body.provider) or {}
    api_key = cfg.get("api_key") or ""
    if not api_key:
        raise HTTPException(status_code=400, detail=f"No admin key saved for provider '{body.provider}'")

    model_id = body.model_id or cfg.get("model_id") or admin_keys_service.default_model_for(body.provider)
    success, error_detail = await test_api_key(api_key, model_id, body.provider)

    if success:
        return AdminAIProviderTestResponse(success=True, message="API Key is valid!")
    try:
        from app.services.scan_error_service import log_error
        from app.services.error_codes import ErrorCode, classify_exception

        code = ErrorCode.UNKNOWN
        if error_detail:
            scan_error = classify_exception(Exception(error_detail))
            code = scan_error.code
        await log_error(
            _admin_uid,
            kind="system",
            code=code,
            message=error_detail or "API key validation failed",
            title=f"Admin API key test failed ({body.provider})",
            data={"provider": body.provider, "model_id": model_id},
        )
    except Exception:
        logger.exception("Failed to persist admin API key test failure")
    return AdminAIProviderTestResponse(success=False, message=error_detail or "API Key is invalid")
