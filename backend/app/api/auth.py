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
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.core.security import get_current_user_id
from app.core.config import settings
from app.services import auth_service

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

    await auth_service.delete_user(uid)
    return None
