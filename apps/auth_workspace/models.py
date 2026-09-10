"""
Workspace sessions: the whole identity model for this app.

There are no user accounts. A visitor pastes a Segment Public API token; we
validate it against `GET /` to derive the workspace, then store the token
encrypted and hand back an opaque session id in an httpOnly cookie. The raw
token never returns to the browser.

Authorization follows from that: a Diagram is readable only when its
workspace_id matches the session's. So reading a workspace's diagrams requires
presenting a valid token for that workspace -- a shared link alone grants
nothing.

An *anonymous* session is the same row with no token at all, for someone drawing
an architecture before they have a customer's token to hand. It is a scope key,
not an account: there is nothing to log in to, it carries no authority over any
real workspace, and `has_token` is False so `HasWorkspaceSession` -- the default
permission -- rejects it everywhere. Its synthetic workspace_id is what lets the
diagrams it saves go through the ordinary path, and `Diagram.reassign_workspace`
is what moves them across when a token finally arrives.
"""

import uuid
from datetime import timedelta

from django.conf import settings
from django.db import models
from django.utils import timezone

from .crypto import decrypt_token, encrypt_token, fingerprint_token


class WorkspaceSessionQuerySet(models.QuerySet):
    def active(self):
        cutoff = timezone.now() - timedelta(hours=settings.WORKSPACE_SESSION_IDLE_HOURS)
        return self.filter(last_seen_at__gte=cutoff)

    def expired(self):
        cutoff = timezone.now() - timedelta(hours=settings.WORKSPACE_SESSION_IDLE_HOURS)
        return self.filter(last_seen_at__lt=cutoff)


class WorkspaceSession(models.Model):
    REGION_CHOICES = [("us", "US"), ("eu", "EU")]

    # How the workspace was connected. Two are offered and the app expresses no preference
    # between them, but they are not interchangeable and the row has to say which it holds:
    #
    #   public_api  a Segment Public API token, scoped and revocable, which every
    #               `SegmentClient` read uses.
    #   graphql     somebody's `auth_token` cookie -- their whole login session, against the
    #               app's own GraphQL gateway. See apps/segmentapi/graphql.py for what that
    #               credential actually is and why it is narrower in what it may be used for.
    #
    # Blank rather than null for an anonymous session, matching `token_fingerprint`: there is
    # no credential, so there is no kind of credential.
    CREDENTIAL_PUBLIC_API = "public_api"
    CREDENTIAL_GRAPHQL = "graphql"
    CREDENTIAL_CHOICES = [
        (CREDENTIAL_PUBLIC_API, "Public API token"),
        (CREDENTIAL_GRAPHQL, "App session (auth_token)"),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    workspace_id = models.CharField(max_length=64, db_index=True)
    workspace_name = models.CharField(max_length=255)
    workspace_slug = models.CharField(max_length=255)
    region = models.CharField(max_length=8, choices=REGION_CHOICES, default="us")

    # NULL means an anonymous session -- see the module docstring. Nullable
    # rather than empty bytes so "no token" cannot be confused with a token that
    # encrypted to nothing, and so the database itself distinguishes the two.
    encrypted_token = models.BinaryField(null=True, blank=True)
    # SHA-256 of the token. Fernet ciphertext is non-deterministic, so this is
    # the only way to recognise a token we have already seen. Blank when there is
    # no token; the uniqueness constraint still holds because every anonymous
    # session gets its own synthetic workspace_id.
    token_fingerprint = models.CharField(max_length=64, db_index=True, blank=True)

    # Defaulted to public_api rather than left blank, because every row that existed before
    # this column did held a Public API token -- a blank default would make every existing
    # session's credential unknown, and `can_read_workspace_api` below would then refuse the
    # sessions that are in fact the only ones it should allow.
    credential_kind = models.CharField(
        max_length=16,
        choices=CREDENTIAL_CHOICES,
        default=CREDENTIAL_PUBLIC_API,
        blank=True,
    )

    created_at = models.DateTimeField(auto_now_add=True)
    last_seen_at = models.DateTimeField(auto_now=True, db_index=True)

    objects = WorkspaceSessionQuerySet.as_manager()

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["workspace_id", "token_fingerprint"],
                name="uniq_workspace_token",
            )
        ]
        indexes = [models.Index(fields=["workspace_id", "-last_seen_at"])]

    def __str__(self):
        return f"{self.workspace_slug} ({self.id})"

    # --- token access -------------------------------------------------------

    @classmethod
    def start(
        cls,
        *,
        token: str,
        workspace: dict,
        region: str = "us",
        credential_kind: str = CREDENTIAL_PUBLIC_API,
    ) -> "WorkspaceSession":
        """
        Create or refresh the session for a validated credential.

        `workspace` is `{id, name, slug}` -- from `GET /` for a Public API token, or from the
        GraphQL gateway's `workspaces` query for an `auth_token`. Re-pasting the same
        credential reuses its row rather than accumulating one session per login.

        `credential_kind` is part of the defaults rather than the lookup, so pasting a Public
        API token for a workspace that was previously connected with an `auth_token` *replaces*
        the credential instead of leaving two rows for one workspace. The uniqueness constraint
        is on (workspace, fingerprint), and two different credentials have two different
        fingerprints -- so both rows can exist, and the newer one is the one the cookie names.
        """
        obj, _ = cls.objects.update_or_create(
            workspace_id=workspace["id"],
            token_fingerprint=fingerprint_token(token),
            defaults={
                "workspace_name": workspace.get("name", "") or "",
                "workspace_slug": workspace.get("slug", "") or "",
                "region": region,
                "encrypted_token": encrypt_token(token),
                "credential_kind": credential_kind,
            },
        )
        return obj

    @classmethod
    def start_anonymous(cls) -> "WorkspaceSession":
        """
        A session with no token, so the canvas is usable before anyone connects.

        The workspace_id is synthetic and random per session rather than a shared
        constant like "anonymous": it is the scoping key for the diagrams saved
        against it, so a shared one would put every anonymous visitor's work in a
        single pile that they could all read.
        """
        return cls.objects.create(
            workspace_id=f"anon:{uuid.uuid4().hex[:12]}",
            workspace_name="",
            workspace_slug="",
            token_fingerprint="",
            encrypted_token=None,
            credential_kind="",
        )

    @property
    def has_token(self) -> bool:
        """Whether this session can act against the Segment API at all."""
        return self.encrypted_token is not None

    @property
    def can_read_workspace_api(self) -> bool:
        """
        Whether this session's credential can be used against the Public API.

        Only a Public API token can. This is the boundary of what the GraphQL option buys
        today: it authenticates, and it names the workspace, but the thirty-six Public API
        endpoints in `apps/segmentapi/endpoints.py` that build the workspace graph have no
        GraphQL equivalents written yet -- so a session holding an `auth_token` must be told
        that rather than sent at `api.segmentapis.com` with a credential it will refuse.

        Asked as a question about the session rather than tested as `credential_kind == ...` at
        each call site, so there is one place to change when the GraphQL reads do exist.
        """
        return self.has_token and self.credential_kind == self.CREDENTIAL_PUBLIC_API

    def reveal_token(self) -> str:
        """
        Decrypt the stored token.

        Only the Segment client layer should call this. It is deliberately a
        method rather than a property so it never gets picked up by a serializer
        or accidentally rendered in a template.
        """
        if not self.has_token:
            # Belt and braces. An anonymous session should never reach the Segment
            # client -- HasWorkspaceSession rejects it -- so getting here means a
            # permission is wrong somewhere, and failing loudly is how that gets
            # found instead of a confusing decryption error.
            raise ValueError("This session has no token: it was never connected to a workspace.")
        return decrypt_token(self.encrypted_token)

    # --- lifetime ----------------------------------------------------------

    @property
    def is_expired(self) -> bool:
        cutoff = timezone.now() - timedelta(hours=settings.WORKSPACE_SESSION_IDLE_HOURS)
        return self.last_seen_at < cutoff

    def touch(self):
        """Slide the idle window. auto_now on last_seen_at does the update."""
        self.save(update_fields=["last_seen_at"])


class WriteKeyRevealAudit(models.Model):
    """
    One row per explicit write-key unmask.

    Write keys are masked everywhere by default; revealing one is a deliberate
    act and worth a trail, since a leaked write key lets anyone send events into
    the customer's workspace.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    workspace_id = models.CharField(max_length=64, db_index=True)
    session_id = models.UUIDField(null=True, blank=True)
    source_id = models.CharField(max_length=255)
    revealed_at = models.DateTimeField(auto_now_add=True, db_index=True)
    user_agent = models.CharField(max_length=512, blank=True)

    class Meta:
        indexes = [models.Index(fields=["workspace_id", "-revealed_at"])]

    def __str__(self):
        return f"{self.workspace_id}/{self.source_id} @ {self.revealed_at:%Y-%m-%d %H:%M}"
