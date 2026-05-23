"""
Security utilities for authentication and authorization.

Handles:
- Firebase ID token verification
- User context extraction
- Multi-tenant access control
- URL path user validation middleware
"""

import logging
from fastapi import Depends, HTTPException, status, Request
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
import firebase_admin
from firebase_admin import auth as firebase_auth
from typing import Optional

logger = logging.getLogger(__name__)

security = HTTPBearer()


async def verify_firebase_token(credentials: HTTPAuthorizationCredentials = Depends(security)) -> str:
    """
    Verify Firebase ID token and return user ID.
    """
    token = credentials.credentials

    try:
        decoded_token = firebase_auth.verify_id_token(token)
        user_id = decoded_token.get("uid")

        if not user_id:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid token: missing user ID",
            )

        return user_id

    except firebase_auth.InvalidIdTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication token",
        )
    except firebase_auth.ExpiredIdTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication token expired",
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Authentication failed: {str(e)}",
        )


async def get_current_user_id(user_id: str = Depends(verify_firebase_token)) -> str:
    """
    Get the current authenticated user ID.
    Also sets the user context for PostgreSQL Row-Level Security.
    """
    from app.core.database import set_current_user_id
    set_current_user_id(user_id)
    return user_id


async def validate_user_access(
    request: Request,
    current_user_id: str = Depends(get_current_user_id),
) -> str:
    """
    Middleware dependency — validates URL path userId matches the authenticated user.
    Use this as a single dependency instead of per-route verify_user_access() calls.

    Extracts userId from the URL path pattern: /api/v1/users/{userId}/...
    Raises 403 if the URL's userId doesn't match the token's uid.
    Logs all 403 attempts as security events.
    """
    # Extract userId from URL path
    path = request.url.path
    parts = path.strip("/").split("/")
    try:
        users_idx = parts.index("users")
        path_user_id = parts[users_idx + 1] if len(parts) > users_idx + 1 else None
    except (ValueError, IndexError):
        path_user_id = None

    if path_user_id and path_user_id != current_user_id:
        logger.warning(
            "SECURITY: Cross-tenant access blocked — token_uid=%s tried URL user=%s | %s %s from %s",
            current_user_id[:16], path_user_id[:16],
            request.method, path, request.client.host if request.client else "unknown",
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied: cannot access other user's data",
        )

    return current_user_id
