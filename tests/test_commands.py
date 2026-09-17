"""
Housekeeping commands.

`reencrypt_tokens` gets the most attention here because a rotation bug is
unrecoverable: if it writes ciphertext the surviving keys cannot read, every
stored token is lost and every customer has to re-paste.
"""

import pytest
from cryptography.fernet import Fernet
from django.core.management import call_command
from django.test import override_settings

from apps.auth_workspace.crypto import decrypt_token
from apps.auth_workspace.models import WorkspaceSession, WriteKeyRevealAudit
from tests.conftest import FAKE_TOKEN, WORKSPACE

pytestmark = pytest.mark.django_db


def _age(session, hours):
    """Backdate last_seen_at. auto_now makes .save() useless for this."""
    from datetime import timedelta

    from django.utils import timezone

    WorkspaceSession.objects.filter(pk=session.pk).update(
        last_seen_at=timezone.now() - timedelta(hours=hours)
    )


# --- clear_expired_sessions -------------------------------------------------

def test_expired_sessions_are_deleted_and_active_ones_kept(session, settings):
    stale = WorkspaceSession.start(
        token="sgp_stale", workspace={"id": "ws_stale", "name": "S", "slug": "s"}
    )
    _age(stale, settings.WORKSPACE_SESSION_IDLE_HOURS + 1)

    call_command("clear_expired_sessions")

    assert not WorkspaceSession.objects.filter(pk=stale.pk).exists()
    assert WorkspaceSession.objects.filter(pk=session.pk).exists()


def test_dry_run_deletes_nothing(session, settings):
    _age(session, settings.WORKSPACE_SESSION_IDLE_HOURS + 1)
    call_command("clear_expired_sessions", "--dry-run")
    assert WorkspaceSession.objects.filter(pk=session.pk).exists()


def test_audit_rows_survive_by_default(session, settings):
    """
    An audit trail that vanishes with the session it describes is not a trail.
    Trimming it has to be asked for explicitly.
    """
    WriteKeyRevealAudit.objects.create(
        workspace_id=WORKSPACE["id"], source_id="src_1", session_id=session.id
    )
    _age(session, settings.WORKSPACE_SESSION_IDLE_HOURS + 1)

    call_command("clear_expired_sessions")
    assert WriteKeyRevealAudit.objects.count() == 1

    call_command("clear_expired_sessions", "--audit-retention-days", "0")
    assert WriteKeyRevealAudit.objects.count() == 0


# --- reencrypt_tokens -------------------------------------------------------

def test_rotation_rewraps_under_the_new_key_and_preserves_the_token(session, settings):
    original_keys = list(settings.SEGMENT_TOKEN_ENCRYPTION_KEYS)
    before = bytes(WorkspaceSession.objects.get(pk=session.pk).encrypted_token)
    new_key = Fernet.generate_key().decode()

    # Step 2 of the documented procedure: prepend, keep the old.
    with override_settings(SEGMENT_TOKEN_ENCRYPTION_KEYS=[new_key, *original_keys]):
        call_command("reencrypt_tokens")
        after = bytes(WorkspaceSession.objects.get(pk=session.pk).encrypted_token)
        assert after != before

        # Step 5: the old key can now be dropped and the row still reads.
        with override_settings(SEGMENT_TOKEN_ENCRYPTION_KEYS=[new_key]):
            assert decrypt_token(after) == FAKE_TOKEN


def test_rotation_dry_run_does_not_write(session, settings):
    before = bytes(WorkspaceSession.objects.get(pk=session.pk).encrypted_token)
    new_key = Fernet.generate_key().decode()
    with override_settings(
        SEGMENT_TOKEN_ENCRYPTION_KEYS=[new_key, *settings.SEGMENT_TOKEN_ENCRYPTION_KEYS]
    ):
        call_command("reencrypt_tokens", "--dry-run")
    after = bytes(WorkspaceSession.objects.get(pk=session.pk).encrypted_token)
    assert after == before


def test_unreadable_rows_are_reported_not_silently_dropped(session):
    """
    A row encrypted under a key that is no longer configured must be counted and
    left alone. Deleting it quietly would look like a successful rotation.
    """
    unreadable_key = Fernet.generate_key().decode()
    orphan = WorkspaceSession.objects.create(
        workspace_id="ws_orphan",
        workspace_name="Orphan",
        workspace_slug="orphan",
        encrypted_token=Fernet(unreadable_key.encode()).encrypt(b"sgp_lost"),
        token_fingerprint="0" * 64,
    )

    call_command("reencrypt_tokens")
    assert WorkspaceSession.objects.filter(pk=orphan.pk).exists()

    call_command("reencrypt_tokens", "--purge-unreadable")
    assert not WorkspaceSession.objects.filter(pk=orphan.pk).exists()
    # The healthy row is untouched by the purge.
    assert WorkspaceSession.objects.filter(pk=session.pk).exists()


def test_rotation_is_idempotent(session):
    call_command("reencrypt_tokens")
    call_command("reencrypt_tokens")
    stored = WorkspaceSession.objects.get(pk=session.pk).encrypted_token
    assert decrypt_token(stored) == FAKE_TOKEN


# --- Regressions in the commands themselves ---------------------------------


def test_reencrypt_skips_sessions_that_have_no_token(session):
    """
    An anonymous session has `encrypted_token = NULL`, and `MultiFernet.rotate(None)`
    raises TypeError -- which `rotate_token` does not catch, because it only expects
    InvalidToken. So a single signed-out visitor used to abort the entire rotation, and
    one is created on every first page load.
    """
    WorkspaceSession.start_anonymous()
    WorkspaceSession.start_anonymous()

    call_command("reencrypt_tokens")

    # The real token still round-trips, and the tokenless rows were left alone.
    session.refresh_from_db()
    assert decrypt_token(session.encrypted_token) == FAKE_TOKEN
    assert WorkspaceSession.objects.filter(encrypted_token=None).count() == 2


def test_sync_catalog_will_not_borrow_a_tokenless_session(db):
    """
    The fallback used to take the most recent session with no filter at all. Anonymous
    sessions are minted constantly, so it almost always picked one and then raised
    ValueError from reveal_token() instead of saying what was wrong.
    """
    from django.core.management.base import CommandError

    WorkspaceSession.start_anonymous()
    with pytest.raises(CommandError, match="No token available"):
        call_command("sync_catalog")


def test_sync_catalog_will_not_borrow_a_graphql_session(db):
    """An app-session credential would hand back a token the Public API rejects."""
    from django.core.management.base import CommandError

    WorkspaceSession.start(
        token="eyJhbGciOiJIUzI1NiJ9.fake.jwt",
        workspace=WORKSPACE,
        region="us",
        credential_kind=WorkspaceSession.CREDENTIAL_GRAPHQL,
    )
    with pytest.raises(CommandError, match="No token available"):
        call_command("sync_catalog")
