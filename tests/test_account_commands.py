"""
The two commands that admit people and repair ownership.

`claim_diagrams` gets the most attention because it is the tool for the failure that
prompted all of this -- diagrams stranded behind a cookie nobody holds any more -- and
because assigning them to the wrong account is not something the app can undo.
"""

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from apps.accounts.admission import admit
from apps.accounts.models import Account, Invitation
from apps.auth_workspace.models import WorkspaceSession
from apps.diagrams.models import Diagram

pytestmark = pytest.mark.django_db


# --- invite_user ------------------------------------------------------------


def test_invite_user_admits_somebody_on_a_cold_start(settings, capsys):
    """
    The bootstrap path. With no allowed domains and no accounts, nothing inside the app
    can issue the first invitation -- inviting requires an account.
    """
    settings.ALLOWED_EMAIL_DOMAINS = []
    call_command("invite_user", "--email", "First@Example.com")

    invitation = Invitation.objects.get()
    assert invitation.email == "first@example.com"
    assert invitation.invited_by is None
    assert invitation.is_pending

    # And the address can now actually get in.
    account, refusal = admit(
        email="first@example.com", google_sub="first-sub", email_verified=True
    )
    assert refusal is None and account is not None


def test_invite_user_says_no_email_was_sent(settings, capsys):
    """
    A command that looked like it sent mail would leave somebody waiting for an email
    that is never coming.
    """
    settings.ALLOWED_EMAIL_DOMAINS = []
    call_command("invite_user", "--email", "someone@elsewhere.com")
    assert "No email was sent" in capsys.readouterr().out


def test_invite_user_declines_to_duplicate_a_pending_invitation(settings, capsys):
    settings.ALLOWED_EMAIL_DOMAINS = []
    call_command("invite_user", "--email", "someone@elsewhere.com")
    call_command("invite_user", "--email", "someone@elsewhere.com")
    assert Invitation.objects.count() == 1
    assert "already invited" in capsys.readouterr().out


def test_invite_user_points_out_a_redundant_invitation(settings, capsys):
    settings.ALLOWED_EMAIL_DOMAINS = ["example.com"]
    call_command("invite_user", "--email", "someone@example.com")
    assert Invitation.objects.count() == 0
    assert "already admitted" in capsys.readouterr().out


def test_invite_user_needs_an_address():
    with pytest.raises(CommandError, match="--email"):
        call_command("invite_user")


def test_invite_user_rejects_something_that_is_not_an_address():
    with pytest.raises(CommandError, match="does not look like"):
        call_command("invite_user", "--email", "not-an-address")


def test_invite_user_list_shows_accounts_and_pending_invitations(settings, account, capsys):
    settings.ALLOWED_EMAIL_DOMAINS = ["example.com"]
    Invitation.objects.create(email="waiting@elsewhere.com")

    call_command("invite_user", "--list")
    out = capsys.readouterr().out
    assert account.email in out
    assert "waiting@elsewhere.com" in out
    assert "example.com" in out


# --- claim_diagrams ---------------------------------------------------------


def test_claim_diagrams_assigns_a_stranded_scope_to_an_account(account, capsys):
    """The repair for the failure that started this: a scope whose cookie is gone."""
    stranded = WorkspaceSession.start_anonymous()
    scope = stranded.anon_scope
    a = Diagram.objects.create(anon_scope=scope, name="One")
    b = Diagram.objects.create(anon_scope=scope, name="Two")
    WorkspaceSession.objects.filter(pk=stranded.pk).delete()

    call_command("claim_diagrams", "--email", account.email, "--scope", scope)

    for diagram in (a, b):
        diagram.refresh_from_db()
        assert diagram.owner == account
        # Cleared, so one owner per diagram.
        assert diagram.anon_scope == ""


def test_claim_diagrams_dry_run_writes_nothing(account, capsys):
    diagram = Diagram.objects.create(anon_scope="anon:abc123", name="Untouched")
    call_command("claim_diagrams", "--email", account.email, "--scope", "anon:abc123", "--dry-run")

    assert "Would assign 1" in capsys.readouterr().out
    diagram.refresh_from_db()
    assert diagram.owner_id is None
    assert diagram.anon_scope == "anon:abc123"


def test_claim_diagrams_can_claim_a_workspace_but_only_unowned_rows(account, capsys):
    """
    Re-running with a workspace id must not take diagrams away from the people who own
    them, which is what an unfiltered update would do.
    """
    other = Account.objects.create(email="sam@example.com", google_sub="sam-sub")
    unowned = Diagram.objects.create(workspace_id="ws_x", name="From before accounts")
    theirs = Diagram.objects.create(owner=other, workspace_id="ws_x", name="Sam's")

    call_command("claim_diagrams", "--email", account.email, "--workspace", "ws_x")

    unowned.refresh_from_db()
    theirs.refresh_from_db()
    assert unowned.owner == account
    assert theirs.owner == other


def test_claim_diagrams_refuses_an_account_that_has_never_signed_in():
    with pytest.raises(CommandError, match="No account for"):
        call_command("claim_diagrams", "--email", "nobody@example.com", "--scope", "anon:x")


def test_claim_diagrams_needs_a_target(account):
    with pytest.raises(CommandError, match="--scope or --workspace"):
        call_command("claim_diagrams", "--email", account.email)


def test_claim_diagrams_refuses_both_targets_at_once(account):
    with pytest.raises(CommandError, match="not both"):
        call_command(
            "claim_diagrams", "--email", account.email, "--scope", "anon:x", "--workspace", "ws_y"
        )


def test_claim_diagrams_reports_an_empty_scope_without_failing(account, capsys):
    call_command("claim_diagrams", "--email", account.email, "--scope", "anon:nothing-here")
    assert "Nothing unowned" in capsys.readouterr().out


def test_claim_diagrams_list_groups_the_orphans(capsys):
    Diagram.objects.create(anon_scope="anon:aaa", name="First")
    Diagram.objects.create(anon_scope="anon:aaa", name="Second")
    Diagram.objects.create(workspace_id="ws_legacy", name="Legacy")

    call_command("claim_diagrams", "--list")
    out = capsys.readouterr().out
    assert "anon:aaa" in out
    assert "First" in out and "Second" in out
    assert "ws_legacy" in out
