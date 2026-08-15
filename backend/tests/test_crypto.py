"""
Pure unit tests for password hashing and local JWT signing — no DB, no network.
"""

import pytest

from app.services.auth_service import (
    hash_password,
    verify_password,
    create_access_token,
    decode_access_token,
)
from app.core.config import settings


# ── Passwords ───────────────────────────────────────────────────────────────

def test_password_hash_roundtrip():
    hashed = hash_password("s3cret!pa55")
    assert hashed != "s3cret!pa55"
    assert verify_password("s3cret!pa55", hashed)


def test_password_rejects_wrong_password():
    hashed = hash_password("correct-horse")
    assert not verify_password("battery-staple", hashed)


def test_password_hashes_are_salted():
    assert hash_password("same-password") != hash_password("same-password")


def test_password_long_input_does_not_raise():
    # bcrypt only uses the first 72 bytes — must truncate, not error.
    long_pw = "x" * 1000
    hashed = hash_password(long_pw)
    assert verify_password(long_pw, hashed)


def test_verify_password_rejects_malformed_hash():
    assert not verify_password("pw", "this-is-not-a-bcrypt-hash")


# ── JWT ─────────────────────────────────────────────────────────────────────

def test_jwt_roundtrip():
    token = create_access_token("uid-123")
    assert decode_access_token(token) == "uid-123"


def test_jwt_rejects_tampered_token():
    token = create_access_token("uid-123")
    # Flip the penultimate char: the LAST base64url char encodes only the 2
    # unused padding bits, so tampering it can leave the signature bytes
    # unchanged and still verify. This position always corrupts the signature.
    flip = "A" if token[-2] != "A" else "B"
    with pytest.raises(ValueError):
        decode_access_token(token[:-2] + flip + token[-1])


def test_jwt_rejects_expired_token(monkeypatch):
    monkeypatch.setattr(settings, "JWT_EXPIRE_DAYS", -1)
    token = create_access_token("uid-123")
    with pytest.raises(ValueError):
        decode_access_token(token)


def test_jwt_rejects_garbage():
    with pytest.raises(ValueError):
        decode_access_token("not.a.jwt")


def test_jwt_requires_subject():
    from jose import jwt as jose_jwt
    bare = jose_jwt.encode({"iss": "scanapp-local"}, settings.SECRET_KEY, algorithm=settings.ALGORITHM)
    with pytest.raises(ValueError):
        decode_access_token(bare)


def test_jwt_different_uids_differ():
    assert create_access_token("uid-1") != create_access_token("uid-2")


def test_jwt_same_uid_decodes_consistently():
    # Same uid minted again (within the same expiry second) is interchangeable.
    token_a = create_access_token("uid-1")
    token_b = create_access_token("uid-1")
    assert decode_access_token(token_a) == "uid-1"
    assert decode_access_token(token_b) == "uid-1"
