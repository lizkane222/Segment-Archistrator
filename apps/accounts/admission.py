"""
Who may hold an account.

One function, in one file, because this is the whole access policy and a policy
spread across a view, a serializer and a permission class is a policy nobody can
read. `views.py` calls `admit()` and does what it says.

The two ways in are a domain on `settings.ALLOWED_EMAIL_DOMAINS` and an
`Invitation` left by someone already using the app. An empty domain list is a
supported state -- invitation-only -- and is why `manage.py invite_user` exists.
"""

import logging

from django.conf import settings
from django.db import transaction

from .models import Account, Invitation

logger = logging.getLogger(__name__)

REFUSAL_UNVERIFIED = "That Google account has no verified email address."
REFUSAL_NOT_INVITED = (
    "This app is limited to approved email domains. Ask someone already using it to "
    "invite you, then sign in again."
)


def normalize_email(email: str) -> str:
    """Lowercased and stripped. Every comparison and every stored value uses this."""
    return (email or "").strip().lower()


def domain_of(email: str) -> str:
    _, _, domain = normalize_email(email).rpartition("@")
    return domain


def domain_allowed(email: str) -> bool:
    """
    Whether this address is admitted by its domain alone.

    Subdomains do not inherit: `ALLOWED_EMAIL_DOMAINS=example.com` admits
    `a@example.com` and not `a@mail.example.com`. Matching suffixes instead would
    make a list entry mean more than it says, and widening it is a one-word edit.
    """
    allowed = {d.strip().lower().lstrip("@") for d in settings.ALLOWED_EMAIL_DOMAINS if d.strip()}
    if not allowed:
        return False
    return domain_of(email) in allowed


@transaction.atomic
def admit(*, email: str, google_sub: str, email_verified: bool = False):
    """
    Decide whether this Google identity may hold an account.

    Returns `(account, refusal)` -- exactly one of which is None. Creates the Account
    when the identity is admitted for the first time, and spends the Invitation that
    admitted it.

    The order of the checks matters:

      1. `email_verified` first. The fallback match on address below trusts the
         address, so an unverified one must never reach it.
      2. An *existing* account before any policy check, so tightening
         ALLOWED_EMAIL_DOMAINS later does not lock out people already using the app.
         Revoking access is a deliberate act (delete the Account), not a side effect
         of editing an env var.
      3. Domain, then invitation. Domain first only because it is the cheaper check;
         they are not ordered by precedence and an invited address inside an allowed
         domain is simply admitted without spending the invitation.
    """
    if not email_verified:
        return None, REFUSAL_UNVERIFIED

    email = normalize_email(email)
    if not email or not google_sub:
        return None, REFUSAL_UNVERIFIED

    existing = Account.objects.filter(google_sub=google_sub).first()
    if existing is None:
        # Fall back to the address. Google's `sub` should never change for one
        # account, but an Account created against a different sub for the same
        # verified address would otherwise collide with the unique constraint and
        # 500 instead of signing them in.
        existing = Account.objects.filter(email=email).first()
        if existing is not None and existing.google_sub != google_sub:
            logger.info("Rebinding account %s to a new Google subject", existing.email)
            existing.google_sub = google_sub
            existing.save(update_fields=["google_sub"])

    if existing is not None:
        return existing, None

    if domain_allowed(email):
        return _create(email=email, google_sub=google_sub), None

    invite = (
        Invitation.objects.select_for_update()
        .filter(email=email, accepted_at__isnull=True)
        .order_by("created_at")
        .first()
    )
    if invite is not None:
        account = _create(email=email, google_sub=google_sub)
        invite.accept(account)
        logger.info("Admitted %s by invitation from %s", email, invite.invited_by or "the CLI")
        return account, None

    logger.info("Refused sign-in for %s: no allowed domain and no invitation", email)
    return None, REFUSAL_NOT_INVITED


def _create(*, email: str, google_sub: str) -> Account:
    account = Account.objects.create(email=email, google_sub=google_sub)
    logger.info("Created account %s", email)
    return account


def invite(*, email: str, invited_by: Account | None) -> Invitation:
    """
    Leave an invitation for an address. Sends nothing -- see `Invitation`.

    Idempotent in the way that matters: an address with a pending invitation gets
    that one back rather than a second row, so inviting twice is harmless and the
    caller can report "already invited" honestly.
    """
    email = normalize_email(email)
    pending = Invitation.objects.filter(email=email, accepted_at__isnull=True).first()
    if pending is not None:
        return pending
    return Invitation.objects.create(email=email, invited_by=invited_by)
