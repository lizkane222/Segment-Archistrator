"""
DRF authentication that turns the session cookie into a workspace principal.

`django.contrib.auth` is not installed, so there is no User model. DRF only
requires that `request.user` be truthy with `is_authenticated` for the default
permission machinery to work, which WorkspacePrincipal satisfies.
"""

import logging
from dataclasses import dataclass

from django.conf import settings
from django.core.exceptions import ValidationError
from django.middleware.csrf import CsrfViewMiddleware
from rest_framework import authentication, exceptions

from .models import WorkspaceSession

logger = logging.getLogger(__name__)

SAFE_METHODS = frozenset(["GET", "HEAD", "OPTIONS", "TRACE"])


class _ForcedCSRFCheck(CsrfViewMiddleware):
    """Surface the rejection reason instead of returning a 403 response."""

    def _reject(self, request, reason):
        return reason


def enforce_csrf(request):
    """
    Run Django's CSRF check explicitly.

    DRF marks every APIView csrf_exempt and expects the authentication class to
    re-enforce CSRF for cookie-based schemes -- which this one is. Without this,
    the session cookie would be usable by a cross-site form post. SameSite=Lax
    already blocks the common case; this is the second layer.
    """
    check = _ForcedCSRFCheck(lambda r: None)
    check.process_request(request)
    reason = check.process_view(request, None, (), {})
    if reason:
        raise exceptions.PermissionDenied(f"CSRF failed: {reason}")


@dataclass(frozen=True)
class WorkspacePrincipal:
    """The authenticated caller: a workspace, proven by possession of a token."""

    session: WorkspaceSession

    # DRF / Django duck-typing. `is_anonymous` is theirs and means "no principal
    # at all", which is not the same thing as this app's tokenless session -- that
    # is `has_token`, and conflating the two would break the permission machinery.
    is_authenticated = True
    is_anonymous = False

    @property
    def has_token(self) -> bool:
        """False for a session that was never connected to a real workspace."""
        return self.session.has_token

    # --- who, as opposed to which workspace ---------------------------------
    #
    # An account is the durable half of identity: it outlives the cookie, which is
    # what makes a diagram reachable after the cookie is lost. The anonymous scope is
    # the other half, and it does not -- it is only as good as the cookie naming it.

    @property
    def account(self):
        """The signed-in person, or None. Anonymous use stays supported."""
        return self.session.account

    @property
    def account_id(self):
        """Cheaper than `account` -- no query. What `visible_to()` filters on."""
        return self.session.account_id

    @property
    def anon_scope(self) -> str:
        return self.session.anon_scope

    @property
    def connected_workspace_ids(self) -> list[str]:
        """
        Every workspace this caller holds a credential for.

        One element today, because a session holds one credential. It is a *list* now
        so that the diagram sharing rule is written against the general case from the
        start -- when a session can hold several connections, this is the only body
        that changes and the authorization rule is untouched.
        """
        return [self.session.workspace_id] if self.session.has_token else []

    @property
    def workspace_id(self) -> str:
        return self.session.workspace_id

    @property
    def workspace_slug(self) -> str:
        return self.session.workspace_slug

    @property
    def workspace_name(self) -> str:
        return self.session.workspace_name

    @property
    def region(self) -> str:
        return self.session.region

    def __str__(self):
        return f"workspace:{self.workspace_slug}"


class WorkspaceSessionAuthentication(authentication.BaseAuthentication):
    """
    Resolve the opaque session cookie to a WorkspacePrincipal.

    Returns None (rather than raising) when there is no usable cookie, so DRF
    falls through to the permission class and produces a clean 401 instead of an
    auth-scheme error.
    """

    def authenticate_header(self, request):
        """
        Make unauthenticated requests 401 rather than 403.

        DRF downgrades NotAuthenticated to 403 when this returns None, which
        collapses "you have no session" and "your session may not touch this"
        into one status. The SPA needs to tell them apart: the first sends the
        visitor back to the token screen, the second is a bug worth surfacing.

        The scheme name is deliberately not `Basic` -- browsers render a native
        credential dialog for that, and there is nothing useful to type into it.
        Unknown schemes are ignored by the browser and carry the status through.
        """
        return "Cookie"

    def authenticate(self, request):
        raw = request.COOKIES.get(settings.WORKSPACE_SESSION_COOKIE)
        if not raw:
            return None

        try:
            session = WorkspaceSession.objects.get(pk=raw)
        except (WorkspaceSession.DoesNotExist, ValidationError, ValueError, TypeError):
            # Unknown or malformed UUID -- treat as unauthenticated rather than
            # erroring. Note ValidationError: Django's UUIDField raises that (not
            # ValueError) when the value is not parseable as a UUID, so a junk
            # cookie would otherwise surface as a 500.
            return None

        if session.is_expired:
            logger.info("Rejecting expired workspace session %s", session.id)
            session.delete()
            return None

        if request.method not in SAFE_METHODS:
            enforce_csrf(request)

        session.touch()
        # Ask the response layer to re-issue the cookie. The server-side clock slides on
        # every request via touch(), but `max_age` was fixed when the cookie was first
        # written -- so an active user was signed out at 12h from *issue* regardless of
        # having just used the app. See `SlidingSessionCookieMiddleware`.
        request._workspace_session_to_refresh = session
        return (WorkspacePrincipal(session=session), None)
