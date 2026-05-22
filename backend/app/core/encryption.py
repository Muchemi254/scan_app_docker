"""
Symmetric encryption for sensitive values stored in Firestore.

Uses Fernet (AES-128-CBC + HMAC) with a key derived from SECRET_KEY.

Encrypted values start with the Fernet token prefix; legacy plaintext values
are detected and returned as-is so existing data continues to work while being
re-encrypted on the next write.
"""
import base64
import hashlib

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import settings

# Fernet tokens always begin with this base64 prefix
_FERNET_PREFIX = "gAAAAA"


def _get_fernet() -> Fernet:
    """Derive a Fernet key from SECRET_KEY."""
    digest = hashlib.sha256(settings.SECRET_KEY.encode()).digest()
    key = base64.urlsafe_b64encode(digest)
    return Fernet(key)


def encrypt_api_key(plaintext: str) -> str:
    """Encrypt an API key before storing in Firestore."""
    if not plaintext:
        return plaintext
    if plaintext.startswith(_FERNET_PREFIX):
        return plaintext  # already encrypted
    return _get_fernet().encrypt(plaintext.encode()).decode()


def decrypt_api_key(ciphertext: str) -> str:
    """
    Decrypt an API key retrieved from Firestore.

    Returns the plaintext value.  Legacy (pre-encryption) values are returned
    as-is so the migration is transparent — they will be encrypted on the next
    write.
    """
    if not ciphertext:
        return ciphertext
    if not ciphertext.startswith(_FERNET_PREFIX):
        return ciphertext  # legacy plaintext — will be encrypted on next save
    try:
        return _get_fernet().decrypt(ciphertext.encode()).decode()
    except InvalidToken:
        return ciphertext
