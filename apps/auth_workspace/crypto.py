"""
Symmetric encryption for stored Public API tokens.

Design notes:

* MultiFernet, not Fernet, so a key can be rotated by prepending a new one to
  SEGMENT_TOKEN_ENCRYPTION_KEYS. Ciphertext written under any listed key stays
  readable; `rotate()` re-wraps it under the newest.
* Fernet ciphertext is non-deterministic (random IV), so it cannot be used to
  look up "have I seen this token before". That is what `fingerprint()` is for:
  a SHA-256 of the token, safe to index and compare, and not reversible.
"""

import hashlib

from cryptography.fernet import Fernet, InvalidToken, MultiFernet
from django.conf import settings
from django.core.exceptions import ImproperlyConfigured

__all__ = ["encrypt_token", "decrypt_token", "fingerprint_token", "TokenDecryptionError"]


class TokenDecryptionError(Exception):
    """Stored ciphertext could not be read under any configured key."""


_cache: dict[tuple[str, ...], MultiFernet] = {}


def _fernet() -> MultiFernet:
    keys = tuple(k.strip() for k in settings.SEGMENT_TOKEN_ENCRYPTION_KEYS if k.strip())
    if not keys:
        raise ImproperlyConfigured(
            "SEGMENT_TOKEN_ENCRYPTION_KEYS is empty; cannot encrypt Segment tokens."
        )
    if keys not in _cache:
        try:
            _cache[keys] = MultiFernet([Fernet(k.encode()) for k in keys])
        except (ValueError, TypeError) as exc:
            raise ImproperlyConfigured(
                "SEGMENT_TOKEN_ENCRYPTION_KEYS contains an invalid Fernet key. "
                "Each must be 32 url-safe base64-encoded bytes."
            ) from exc
    return _cache[keys]


def encrypt_token(token: str) -> bytes:
    """Encrypt under the newest configured key."""
    return _fernet().encrypt(token.encode())


def decrypt_token(blob: bytes | memoryview) -> str:
    """
    Decrypt, trying every configured key.

    psycopg hands back a memoryview for BinaryField, which Fernet rejects, so
    normalize to bytes first.
    """
    if isinstance(blob, memoryview):
        blob = blob.tobytes()
    try:
        return _fernet().decrypt(blob).decode()
    except InvalidToken as exc:
        raise TokenDecryptionError(
            "Stored token could not be decrypted under any configured key. "
            "The key may have been rotated out of SEGMENT_TOKEN_ENCRYPTION_KEYS."
        ) from exc


def rotate_token(blob: bytes | memoryview) -> bytes:
    """Re-wrap existing ciphertext under the newest key, without exposing plaintext."""
    if isinstance(blob, memoryview):
        blob = blob.tobytes()
    try:
        return _fernet().rotate(blob)
    except InvalidToken as exc:
        raise TokenDecryptionError("Cannot rotate: ciphertext unreadable.") from exc


def fingerprint_token(token: str) -> str:
    """
    Stable, non-reversible identifier for a token.

    Used to recognise a returning token and reuse its session row instead of
    accumulating one row per login.
    """
    return hashlib.sha256(token.encode()).hexdigest()
