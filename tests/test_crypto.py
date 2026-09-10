"""
Token encryption. This is the file that guards the brief's one hard security
requirement, so it tests the properties rather than the implementation.
"""

import pytest
from cryptography.fernet import Fernet
from django.test import override_settings

from apps.auth_workspace import crypto

TOKEN = "sgp_secret_value_do_not_leak"


def test_round_trip():
    assert crypto.decrypt_token(crypto.encrypt_token(TOKEN)) == TOKEN


def test_ciphertext_does_not_contain_the_plaintext():
    assert TOKEN.encode() not in crypto.encrypt_token(TOKEN)


def test_ciphertext_is_non_deterministic():
    """
    Fernet embeds a random IV, so the same token encrypts differently each time.

    This is exactly why WorkspaceSession stores a separate SHA-256 fingerprint:
    ciphertext comparison could never recognise a returning token.
    """
    assert crypto.encrypt_token(TOKEN) != crypto.encrypt_token(TOKEN)


def test_fingerprint_is_stable_and_distinct():
    assert crypto.fingerprint_token(TOKEN) == crypto.fingerprint_token(TOKEN)
    assert crypto.fingerprint_token(TOKEN) != crypto.fingerprint_token(TOKEN + "x")
    assert len(crypto.fingerprint_token(TOKEN)) == 64


def test_fingerprint_is_not_reversible():
    assert TOKEN not in crypto.fingerprint_token(TOKEN)


def test_decrypt_accepts_memoryview():
    """psycopg returns BinaryField values as memoryview, not bytes."""
    ciphertext = crypto.encrypt_token(TOKEN)
    assert crypto.decrypt_token(memoryview(ciphertext)) == TOKEN


def test_old_key_still_decrypts_after_rotation():
    """
    Prepending a new key must not orphan existing ciphertext -- otherwise every
    stored session breaks on the deploy that rotates the key.
    """
    old_key = Fernet.generate_key().decode()
    new_key = Fernet.generate_key().decode()

    # The MultiFernet cache is keyed on the key tuple, so override_settings alone
    # is enough to switch key sets -- no cache clearing needed.
    with override_settings(SEGMENT_TOKEN_ENCRYPTION_KEYS=[old_key]):
        ciphertext = crypto.encrypt_token(TOKEN)

    with override_settings(SEGMENT_TOKEN_ENCRYPTION_KEYS=[new_key, old_key]):
        assert crypto.decrypt_token(ciphertext) == TOKEN
        # New writes use the newest key.
        fresh = crypto.encrypt_token(TOKEN)

    with override_settings(SEGMENT_TOKEN_ENCRYPTION_KEYS=[new_key]):
        assert crypto.decrypt_token(fresh) == TOKEN
        with pytest.raises(crypto.TokenDecryptionError):
            crypto.decrypt_token(ciphertext)


def test_decrypt_rejects_garbage():
    with pytest.raises(crypto.TokenDecryptionError):
        crypto.decrypt_token(b"not-a-fernet-token")
