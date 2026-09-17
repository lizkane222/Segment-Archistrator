"""
Sign-in, sign-out, and invitations.

    GET  /api/auth/google/start     -> 302 to Google
    GET  /api/auth/google/callback  -> 302 back to the SPA, cookie set
    POST /api/auth/logout           -> drop the account, keep a usable session
    GET  /api/invitations           -> invitations I have left
    POST /api/invitations           -> leave one (sends no mail)

The two Google endpoints are browser *navigations*, not API calls: they answer with
redirects because the browser physically leaves for Google and comes back. Everything
the SPA needs to know afterwards arrives as a query parameter on `/`, which it reads
once on boot and then clears from the URL.
"""

import logging
import secrets
from urllib.parse import urlencode

from django.db import transaction
from django.http import HttpResponseRedirect
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_protect
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.auth_workspace.authentication import WorkspacePrincipal
from apps.auth_workspace.models import WorkspaceSession
from apps.auth_workspace.permissions import AllowAny, HasSession
from apps.auth_workspace.views import session_payload, set_session_cookie
from apps.diagrams.models import Diagram

from . import google
from .admission import admit, invite
from .models import OAuthLogin
from .serializers import (
    CreateInvitationSerializer,
    InvitationSerializer,
)

logger = logging.getLogger(__name__)


def _back_to_app(**params) -> HttpResponseRedirect:
    """
    Home, with a one-shot message for the SPA.

    A query parameter rather than a flash cookie or a stashed row: it needs to survive
    exactly one navigation and be readable before React has mounted anything, and the
    SPA strips it from the URL once read.
    """
    query = urlencode({k: v for k, v in params.items() if v})
    return HttpResponseRedirect(f"/?{query}" if query else "/")


class GoogleStartView(APIView):
    """
    Begin the round trip.

    Open, and it has to be: someone signing in has no account yet by definition. What
    keeps it from being useful to an attacker is that it grants nothing -- it hands out
    a redirect to Google and a `state` row, and the callback is where proof is demanded.
    """

    permission_classes = [AllowAny]

    def get(self, request):
        if not google.is_configured():
            # A deployment that has not finished being set up. Saying so beats
            # bouncing someone to a Google error page about an empty client id.
            return _back_to_app(auth_error="Sign-in is not configured on this server.")

        # Carry the session that started this, so its anonymous diagrams can be
        # claimed on the way back. Read from the cookie on *this* request -- the same
        # rule the workspace claim follows in apps/auth_workspace/views.py.
        session_id = None
        if isinstance(request.user, WorkspacePrincipal):
            session_id = request.user.session.id

        verifier, challenge = google.pkce_pair()
        login = OAuthLogin.objects.create(
            state=secrets.token_urlsafe(32), session_id=session_id, code_verifier=verifier
        )
        return HttpResponseRedirect(
            google.consent_url(
                state=login.state,
                redirect_to=google.redirect_uri(request),
                code_challenge=challenge,
            )
        )


class GoogleCallbackView(APIView):
    """
    Finish the round trip: prove it started here, then sign the person in.

    Every failure path ends in a redirect carrying a sentence, never a JSON error
    body -- the browser arrived here by navigation and a raw JSON page would be a
    dead end.
    """

    permission_classes = [AllowAny]

    def get(self, request):
        # Google's own refusal (someone hit Cancel on the consent screen).
        if request.query_params.get("error"):
            return _back_to_app(auth_error="Sign-in was cancelled.")

        state = request.query_params.get("state") or ""
        code = request.query_params.get("code") or ""
        if not state or not code:
            return _back_to_app(auth_error="That sign-in link was incomplete. Try again.")

        login = self._consume(state)
        if login is None:
            # Unknown, already used, or too old. One message for all three: telling a
            # caller which of those it was tells them something about rows they do
            # not own.
            return _back_to_app(auth_error="That sign-in link has expired. Try again.")

        try:
            identity = google.exchange_code(
                code=code,
                redirect_to=google.redirect_uri(request),
                code_verifier=login.code_verifier,
            )
        except google.GoogleAuthError as err:
            return _back_to_app(auth_error=str(err))

        account, refusal = admit(
            email=identity["email"],
            google_sub=identity["sub"],
            email_verified=identity["email_verified"],
        )
        if account is None:
            return _back_to_app(auth_error=refusal)

        # Keep the display fields fresh on every sign-in -- someone's name or avatar
        # changing at Google should show up here without a migration or a re-invite.
        account.name = identity["name"] or account.name
        account.avatar_url = identity["picture"] or account.avatar_url
        account.save(update_fields=["name", "avatar_url"])
        account.touch_login()

        session, claimed = self._establish_session(login, account)
        logger.info(
            "Signed in %s, claimed %d diagram(s) from the anonymous scope", account.email, claimed
        )
        return set_session_cookie(
            _back_to_app(signed_in=account.email, claimed=claimed or ""), session
        )

    @staticmethod
    def _consume(state: str) -> OAuthLogin | None:
        """
        Fetch-and-delete, so a replayed callback finds nothing.

        Deleting is what makes this single-use; that is the whole reason `state` is a
        row and not a signed cookie, which would stay valid for its lifetime.
        """
        with transaction.atomic():
            login = OAuthLogin.objects.select_for_update().filter(state=state).first()
            if login is None:
                return None
            login.delete()
        return None if login.is_expired else login

    @staticmethod
    def _establish_session(login: OAuthLogin, account) -> tuple[WorkspaceSession, int]:
        """
        Give this browser a session belonging to the account, and claim what it drew.

        The session id is deliberately *rotated*: the row that started the flow is
        replaced rather than updated, so a session id that was floating around before
        anyone signed in cannot be used afterwards. The anonymous scope is carried
        across first, because it is the only proof of which unsaved work was theirs.
        """
        with transaction.atomic():
            anon_scope = ""
            outgoing = None
            if login.session_id:
                outgoing = WorkspaceSession.objects.filter(pk=login.session_id).first()
            if outgoing is not None:
                # Signing in as somebody else in a browser that was already signed in.
                # Do NOT carry the scope across: it and everything under it belong to
                # the previous account, and handing them to the new one would be a
                # data breach wearing the costume of a convenience. Start clean.
                if outgoing.account_id and outgoing.account_id != account.id:
                    logger.info("Sign-in switched accounts; not claiming the previous scope")
                else:
                    anon_scope = outgoing.anon_scope

            session = WorkspaceSession.start_for_account(account, anon_scope=anon_scope)

            claimed = 0
            if anon_scope:
                claimed = Diagram.objects.claim_for_account(
                    anon_scope=anon_scope, account=account
                )
            if outgoing is not None:
                outgoing.delete()
        return session, claimed


@method_decorator(csrf_protect, name="post")
class LogoutView(APIView):
    """
    Drop the account, keep the canvas usable.

    Not the same as `DELETE /api/session`, which forgets a *workspace credential*.
    Signing out of an account leaves someone anonymous rather than stranded, for the
    same reason the app hands a tokenless visitor a scope instead of a login screen.

    The session id is rotated here too, so the pre-logout cookie is inert.
    """

    permission_classes = [HasSession]

    def post(self, request):
        outgoing = request.user.session
        with transaction.atomic():
            session = WorkspaceSession.start_anonymous()
            outgoing.delete()
        # The same shape every other session endpoint answers with, so the client has one
        # thing to understand and cannot be handed a session it reads as absent.
        return set_session_cookie(Response(session_payload(session)), session)


@method_decorator(csrf_protect, name="post")
class InvitationView(APIView):
    """
    Invitations I have left.

    Any account may invite, including one that was itself invited. There are no roles
    in this app; see the note in `apps/accounts/models.py` about what that permits.
    """

    permission_classes = [HasSession]

    def get(self, request):
        account = request.user.account
        if account is None:
            return self._needs_account()
        invitations = account.invitations_sent.all()
        return Response({"items": InvitationSerializer(invitations, many=True).data})

    def post(self, request):
        account = request.user.account
        if account is None:
            return self._needs_account()

        serializer = CreateInvitationSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        email = serializer.validated_data["email"]

        existing = account.invitations_sent.filter(email=email, accepted_at__isnull=True).first()
        invitation = invite(email=email, invited_by=account)

        return Response(
            {
                "invitation": InvitationSerializer(invitation).data,
                # So the UI can say "already invited" rather than implying a second
                # invitation was created, and can be honest that nothing was sent.
                "alreadyInvited": existing is not None,
                "emailSent": False,
            },
            status=status.HTTP_200_OK if existing else status.HTTP_201_CREATED,
        )

    @staticmethod
    def _needs_account():
        return Response(
            {
                "error": {
                    "code": "account_required",
                    "message": "Sign in to invite someone.",
                }
            },
            status=status.HTTP_403_FORBIDDEN,
        )
