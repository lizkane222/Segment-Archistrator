"""
Who may hold an account.

This is the whole access policy, so it gets tested as a matrix rather than through the
OAuth flow -- `admit()` is a function, and driving it directly is how the cases stay
readable. The flow that calls it is `tests/test_oauth.py`.
"""

import pytest

from apps.accounts.admission import admit, domain_allowed, invite, normalize_email
from apps.accounts.models import Account, Invitation

pytestmark = pytest.mark.django_db


# --- Domains ----------------------------------------------------------------


def test_an_allowed_domain_is_admitted_and_creates_an_account(settings):
    settings.ALLOWED_EMAIL_DOMAINS = ["example.com"]
    account, refusal = admit(email="new@example.com", google_sub="sub-1", email_verified=True)

    assert refusal is None
    assert account.email == "new@example.com"
    assert Account.objects.count() == 1


def test_a_stranger_is_refused_and_no_account_is_created(settings):
    settings.ALLOWED_EMAIL_DOMAINS = ["example.com"]
    account, refusal = admit(email="nope@elsewhere.com", google_sub="sub-2", email_verified=True)

    assert account is None
    assert "invite you" in refusal
    assert Account.objects.count() == 0


def test_a_subdomain_does_not_inherit_the_allowance(settings):
    """
    `example.com` admits `a@example.com` and not `a@mail.example.com`.

    Suffix matching would make one list entry mean more than it says, and widening it
    deliberately is a one-word edit.
    """
    settings.ALLOWED_EMAIL_DOMAINS = ["example.com"]
    assert domain_allowed("a@example.com")
    assert not domain_allowed("a@mail.example.com")
    assert not domain_allowed("a@notexample.com")


def test_an_empty_domain_list_admits_nobody_by_domain(settings):
    """Invitation-only is a supported configuration, not a broken one."""
    settings.ALLOWED_EMAIL_DOMAINS = []
    assert not domain_allowed("anyone@example.com")

    account, refusal = admit(email="anyone@example.com", google_sub="sub-3", email_verified=True)
    assert account is None
    assert refusal


def test_the_domain_list_tolerates_stray_whitespace_and_at_signs(settings):
    settings.ALLOWED_EMAIL_DOMAINS = [" @Example.COM ", ""]
    assert domain_allowed("someone@example.com")


# --- Verification -----------------------------------------------------------


def test_an_unverified_email_is_refused(settings):
    """
    Checked first, because the fallback match on address below trusts the address.
    """
    settings.ALLOWED_EMAIL_DOMAINS = ["example.com"]
    account, refusal = admit(email="new@example.com", google_sub="sub-4", email_verified=False)

    assert account is None
    assert "verified" in refusal
    assert Account.objects.count() == 0


# --- Invitations ------------------------------------------------------------


def test_an_invited_stranger_is_admitted_and_the_invitation_is_spent(settings, account):
    settings.ALLOWED_EMAIL_DOMAINS = ["example.com"]
    invitation = invite(email="guest@elsewhere.com", invited_by=account)

    admitted, refusal = admit(
        email="guest@elsewhere.com", google_sub="sub-5", email_verified=True
    )

    assert refusal is None
    assert admitted.email == "guest@elsewhere.com"
    invitation.refresh_from_db()
    assert not invitation.is_pending
    assert invitation.accepted_by == admitted


def test_an_invitation_is_single_use(settings, account):
    """
    A second person presenting the same address must not ride in on a spent invitation.
    """
    settings.ALLOWED_EMAIL_DOMAINS = []
    invite(email="guest@elsewhere.com", invited_by=account)

    first, _ = admit(email="guest@elsewhere.com", google_sub="sub-6", email_verified=True)
    assert first is not None

    # Same address, different Google identity, and the invitation is gone.
    Account.objects.filter(pk=first.pk).delete()
    second, refusal = admit(
        email="guest@elsewhere.com", google_sub="sub-7", email_verified=True
    )
    assert second is None
    assert refusal


def test_an_invited_account_can_itself_invite(settings, account):
    """
    No roles: whoever is in may admit others, including someone who was invited.
    """
    settings.ALLOWED_EMAIL_DOMAINS = []
    invite(email="guest@elsewhere.com", invited_by=account)
    guest, _ = admit(email="guest@elsewhere.com", google_sub="sub-8", email_verified=True)

    invite(email="second@elsewhere.com", invited_by=guest)
    admitted, refusal = admit(
        email="second@elsewhere.com", google_sub="sub-9", email_verified=True
    )
    assert refusal is None
    assert admitted.email == "second@elsewhere.com"


def test_inviting_the_same_address_twice_reuses_the_pending_invitation(account):
    first = invite(email="guest@elsewhere.com", invited_by=account)
    second = invite(email="guest@elsewhere.com", invited_by=account)
    assert first.pk == second.pk
    assert Invitation.objects.count() == 1


def test_an_invitation_inside_an_allowed_domain_is_not_spent(settings, account):
    """The domain admits them, so there is nothing for the invitation to do."""
    settings.ALLOWED_EMAIL_DOMAINS = ["example.com"]
    invitation = invite(email="both@example.com", invited_by=account)

    admitted, refusal = admit(email="both@example.com", google_sub="sub-10", email_verified=True)
    assert refusal is None and admitted is not None

    invitation.refresh_from_db()
    assert invitation.is_pending


# --- Existing accounts ------------------------------------------------------


def test_an_existing_account_is_admitted_even_after_its_domain_is_dropped(settings, account):
    """
    Tightening ALLOWED_EMAIL_DOMAINS must not lock out people already using the app.
    Revoking access is deleting the Account, not editing an env var.
    """
    settings.ALLOWED_EMAIL_DOMAINS = ["somewhere-else.com"]
    admitted, refusal = admit(
        email=account.email, google_sub=account.google_sub, email_verified=True
    )
    assert refusal is None
    assert admitted.pk == account.pk
    assert Account.objects.count() == 1


def test_the_google_subject_is_the_identity_not_the_address(settings, account):
    """A renamed address on the same Google account stays one account."""
    settings.ALLOWED_EMAIL_DOMAINS = []
    admitted, refusal = admit(
        email="renamed@example.com", google_sub=account.google_sub, email_verified=True
    )
    assert refusal is None
    assert admitted.pk == account.pk


def test_a_verified_address_on_a_new_subject_rebinds_rather_than_colliding(settings, account):
    """
    `email` is unique, so a second Google subject presenting the same verified address
    would otherwise hit the constraint and 500 instead of signing them in.
    """
    settings.ALLOWED_EMAIL_DOMAINS = []
    admitted, refusal = admit(
        email=account.email, google_sub="a-different-subject", email_verified=True
    )
    assert refusal is None
    assert admitted.pk == account.pk

    account.refresh_from_db()
    assert account.google_sub == "a-different-subject"
    assert Account.objects.count() == 1


# --- Normalization ----------------------------------------------------------


def test_addresses_are_stored_and_matched_lowercased(settings):
    settings.ALLOWED_EMAIL_DOMAINS = ["example.com"]
    account, _ = admit(email="  MiXeD@Example.COM ", google_sub="sub-11", email_verified=True)
    assert account.email == "mixed@example.com"

    again, refusal = admit(email="mixed@example.com", google_sub="sub-11", email_verified=True)
    assert refusal is None and again.pk == account.pk


def test_normalize_email_handles_none_and_blanks():
    assert normalize_email(None) == ""
    assert normalize_email("  ") == ""
