"""
People, as distinct from Segment credentials.

`apps/auth_workspace` answers "which workspace, proven how" -- a pasted token, a
scope to save into, a cookie naming it. This app answers "who", and it exists as a
separate app because the two were conflated and that conflation was the bug: a
`WorkspaceSession` row was simultaneously the identity, the credential and the
authorization scope, so losing the cookie lost the work behind it with no way back.

An Account survives the cookie. It is the durable half of identity, and the reason
`Diagram.owner` can be a foreign key where `Diagram.workspace_id` had to stay a
bare string.

## Why not django.contrib.auth

`config/settings/base.py` states its absence as a design decision, and Google
holding the passwords keeps it that way: there is nothing to hash, no reset flow to
build, no admin to gate, and no permission framework in use. Three small models are
less machinery than `auth` + `admin` + `sessions` and the migrations they bring.

## Access

Sign-in is not open. An address is admitted when its domain is in
`settings.ALLOWED_EMAIL_DOMAINS`, or when someone already using the app has left an
`Invitation` for it. See `admission.admit`, which is where that decision lives and
is the only place it should be made.
"""

import uuid
from datetime import timedelta

from django.db import models
from django.utils import timezone


class Account(models.Model):
    """
    One person, identified by Google.

    `google_sub` is Google's stable subject id and is the real key -- an address can
    change hands, `sub` cannot. `email` is kept unique anyway because it is what an
    `Invitation` names and what a human recognises, and it is always stored
    lowercased so that uniqueness means what it looks like it means.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    email = models.EmailField(unique=True)
    # Google's `sub` claim. Max 255 by spec; 64 is comfortable for the numeric ids
    # Google actually issues, and indexing it is what every sign-in looks up.
    google_sub = models.CharField(max_length=64, unique=True, db_index=True)

    name = models.CharField(max_length=255, blank=True)
    avatar_url = models.URLField(blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    last_login_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["email"]

    def __str__(self):
        return self.email

    def touch_login(self):
        self.last_login_at = timezone.now()
        self.save(update_fields=["last_login_at"])


class Invitation(models.Model):
    """
    Pre-authorization for one email address.

    **No mail is sent.** There is no email backend in this project and adding one was
    not part of the ask, so an invitation is purely a record that an address may sign
    in; the inviter passes the app's URL along themselves. The UI says so rather than
    implying a message went out.

    `email` is deliberately not unique: an address that was invited, never used, and
    invited again by someone else is two facts, and the second should not fail.
    `admit` takes the oldest unaccepted one.

    Anyone with an account may create these, including someone who was themselves
    invited. That is intentional -- there are no roles in this app -- and it means one
    admitted stranger can admit others, which is the accepted cost of not building an
    approval queue.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    email = models.EmailField(db_index=True)  # lowercased on the way in
    # Null means it came from `manage.py invite_user`, which is how a fresh
    # deployment admits its first person -- there is no account to attribute it to yet.
    invited_by = models.ForeignKey(
        Account,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="invitations_sent",
    )

    created_at = models.DateTimeField(auto_now_add=True)

    # Set together, and their presence is what "spent" means -- an invitation is
    # single-use. Kept rather than deleted so the trail of who admitted whom survives.
    accepted_at = models.DateTimeField(null=True, blank=True)
    accepted_by = models.ForeignKey(
        Account, null=True, blank=True, on_delete=models.SET_NULL, related_name="+"
    )

    class Meta:
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["email", "accepted_at"])]

    def __str__(self):
        state = "accepted" if self.accepted_at else "pending"
        return f"{self.email} ({state})"

    @property
    def is_pending(self) -> bool:
        return self.accepted_at is None

    def accept(self, account: Account):
        self.accepted_at = timezone.now()
        self.accepted_by = account
        self.save(update_fields=["accepted_at", "accepted_by"])


class OAuthLogin(models.Model):
    """
    One in-flight OAuth round trip, so the callback can prove it started here.

    A row rather than a signed cookie because this is deleted the moment it is used,
    which is what makes a replayed callback fail. A signed cookie carrying the same
    nonce would stay valid for its whole lifetime, and replay protection is most of
    the point.

    It also carries the session that began the flow, which is how a visitor's
    anonymous diagrams get claimed on sign-in: the browser is about to leave for
    Google and come back, and the cookie is the only thing that proves which
    anonymous scope was theirs.
    """

    # Ten minutes is long enough to pick an account and type a password, short
    # enough that an abandoned row is not a standing liability.
    EXPIRY_MINUTES = 10

    state = models.CharField(max_length=64, unique=True, db_index=True)
    session_id = models.UUIDField(null=True, blank=True)
    # The PKCE verifier whose challenge went to Google. Kept server-side, which is the
    # whole mechanism: the code is only redeemable by whoever started the flow.
    code_verifier = models.CharField(max_length=128, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ["-created_at"]

    def __str__(self):
        return f"oauth:{self.state[:8]}…"

    @property
    def is_expired(self) -> bool:
        cutoff = timezone.now() - timedelta(minutes=self.EXPIRY_MINUTES)
        return self.created_at < cutoff
