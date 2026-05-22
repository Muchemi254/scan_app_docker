"""
Security utilities for authentication and authorization.

Handles:
- Firebase ID token verification
- User context extraction
- Multi-tenant access control
"""

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
import firebase_admin
from firebase_admin import auth as firebase_auth
from typing import Optional

security = HTTPBearer()


async def verify_firebase_token(credentials: HTTPAuthorizationCredentials = Depends(security)) -> str:
    """
    Verify Firebase ID token and return user ID.

    Args:
        credentials: HTTP bearer token from request header

    Returns:
        User ID (Firebase UID)

    Raises:
        HTTPException: If token is invalid or expired
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

    This is a dependency that ensures all protected routes require authentication.

    Args:
        user_id: Extracted from Firebase token

    Returns:
        User ID
    """
    return user_id
