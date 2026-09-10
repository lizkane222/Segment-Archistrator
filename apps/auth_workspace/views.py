"""
Session endpoints: the entire login surface.

POST   /api/session             paste a token -> validated, encrypted, cookie set
GET    /api/session             who am I (workspace only, never the token)
DELETE /api/session             log out, delete the stored row
POST   /api/session/anonymous   a scope to save into before connecting anything
"""

import logging

from django.conf import settings
from django.db import transaction
from django.utils.decorators import method_decorator
from django.views.decorators.csrf import csrf_protect, ensure_csrf_cookie
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.diagrams.models import Diagram
from apps.segmentapi.client import SegmentClient
from apps.segmentapi.exceptions import SegmentAuthError, SegmentError
from apps.segmentapi.graphql import SegmentGraphQLClient

from .authentication import WorkspacePrincipal
from .models import WorkspaceSession
from .permissions import AllowAny, HasWorkspaceSession
from .serializers import StartSessionSerializer, WorkspaceSerializer

logger = logging.getLogger(__name__)


def set_session_cookie(response, session):
    response.set_cookie(
        settings.WORKSPACE_SESSION_COOKIE,
        str(session.id),
        max_age=settings.WORKSPACE_SESSION_IDLE_HOURS * 3600,
        httponly=True,
        samesite="Lax",
        secure=not settings.DEBUG,
        path="/",
    )
    return response


@method_decorator(ensure_csrf_cookie, name="get")
@method_decorator(csrf_protect, name="post")
@method_decorator(csrf_protect, name="delete")
class SessionView(APIView):
    """
    The token-as-identity endpoint.

    GET is deliberately open and sets the CSRF cookie, so a cold-start SPA can
    call it to discover both whether it has a session and the CSRF token it will
    need in order to create one.
    """

    def get_permissions(self):
        if self.request.method in ("GET", "POST"):
            return [AllowAny()]
        return [HasWorkspaceSession()]

    def get(self, request):
        if request.user is None or not getattr(request.user, "is_authenticated", False):
            return Response(
                {"workspace": None, "connected": False, "anonymous": False},
                status=status.HTTP_200_OK,
            )
        # Three states, not two: no cookie at all, a cookie for a tokenless scope,
        # and a connected workspace. The SPA needs the middle one distinguishable
        # so it knows a scope already exists and does not mint a second one on
        # every reload, orphaning whatever the first one saved.
        connected = request.user.has_token
        return Response(
            {
                "workspace": WorkspaceSerializer(request.user.session).data if connected else None,
                "connected": connected,
                "anonymous": not connected,
            },
            status=status.HTTP_200_OK,
        )

    def post(self, request):
        serializer = StartSessionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        token = serializer.validated_data["token"]
        region = serializer.validated_data["region"]
        credential = serializer.validated_data["credential"]
        chosen = (serializer.validated_data.get("workspace_id") or "").strip()

        # Two ways in, and the app has no preference between them -- the caller says which it
        # is bringing. What differs is only how the workspace is derived: a Public API token
        # belongs to one workspace and `GET /` names it; an auth_token is a person, so the
        # workspace is a choice that may need asking about first.
        if credential == WorkspaceSession.CREDENTIAL_GRAPHQL:
            outcome = self._workspace_from_graphql(token, region=region, chosen=chosen)
            if isinstance(outcome, Response):
                return outcome
            workspace = outcome
            # The workspace's own region wins over whatever the dialog had selected. A person's
            # auth_token can see workspaces in both regions, so the radio button is a guess at
            # this point and the gateway's answer is the fact -- and storing the wrong one would
            # point every later read at the wrong host.
            region = workspace.get("region") or region
        else:
            outcome = self._workspace_from_public_api(token, region=region)
            if isinstance(outcome, Response):
                return outcome
            workspace = outcome

        # Read the outgoing session before it is replaced. Holding this cookie is
        # the only proof of ownership over an anonymous scope, so the claim has to
        # be decided here, on this request, and never from anything the client says.
        outgoing = request.user if isinstance(request.user, WorkspacePrincipal) else None
        anonymous_scope = (
            outgoing.workspace_id if outgoing is not None and not outgoing.has_token else None
        )

        with transaction.atomic():
            session = WorkspaceSession.start(
                token=token,
                workspace=workspace,
                region=region,
                credential_kind=credential,
            )
            claimed = 0
            if anonymous_scope:
                claimed = Diagram.objects.reassign_workspace(
                    from_id=anonymous_scope, to_id=session.workspace_id
                )
                # Drop the row too. Its scope is now empty and unreachable -- the
                # cookie naming it is about to be overwritten -- so leaving it
                # behind would only accumulate dead sessions.
                WorkspaceSession.objects.filter(workspace_id=anonymous_scope).delete()

        logger.info(
            "Started %s session for workspace %s (%s), claimed %d diagram(s)",
            credential,
            session.workspace_slug,
            session.workspace_id,
            claimed,
        )

        return set_session_cookie(
            Response(
                {"workspace": WorkspaceSerializer(session).data, "claimed": claimed},
                status=status.HTTP_201_CREATED,
            ),
            session,
        )

    # --- deriving the workspace from each kind of credential -----------------
    #
    # Both return either the workspace dict or a ready `Response` to send back. Returning the
    # response rather than raising keeps the two error shapes -- "rejected" and "which one?" --
    # written where the sentence explaining them belongs, and `post` above stays a description
    # of the flow rather than a pile of try/except.

    def _workspace_from_public_api(self, token, *, region):
        # Validate before persisting anything. A rejected token leaves no row and
        # fails immediately -- the retry policy excludes 401 for exactly this.
        client = SegmentClient.for_token(token, region=region)
        try:
            return client.get_workspace()
        except SegmentAuthError:
            # Log the failure without the token or any prefix of it.
            logger.info("Rejected a Segment token for region=%s", region)
            return Response(
                {
                    "error": {
                        "code": "invalid_token",
                        "message": (
                            "Segment rejected that token. Check that it is a "
                            "Public API token for the selected region and that it "
                            "has not been revoked."
                        ),
                    }
                },
                status=status.HTTP_401_UNAUTHORIZED,
            )

    def _workspace_from_graphql(self, token, *, region, chosen):
        client = SegmentGraphQLClient(token, region=region)
        try:
            workspaces = client.list_workspaces()
        except SegmentAuthError as err:
            logger.info("Rejected a Segment auth_token for region=%s", region)
            return Response(
                {"error": {"code": "invalid_token", "message": str(err)}},
                status=status.HTTP_401_UNAUTHORIZED,
            )
        except SegmentError as err:
            # Not a 401. The credential worked and Segment answered -- reporting this as
            # "invalid token" would send the user to re-copy something that is fine.
            logger.info("Segment GraphQL gateway error while listing workspaces: %s", err)
            return Response(
                {"error": {"code": "graphql_error", "message": str(err)}},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        if chosen:
            match = next((entry for entry in workspaces if entry["id"] == chosen), None)
            if match is None:
                # Deliberately says how many it *can* see rather than listing them: the client
                # has the list already (it asked, got the choice, and sent one back), and a
                # mismatch here means the credential changed under it.
                return Response(
                    {
                        "error": {
                            "code": "workspace_not_visible",
                            "message": (
                                "That auth_token cannot see the workspace you picked. It can "
                                f"see {len(workspaces)}. Try connecting again."
                            ),
                        }
                    },
                    status=status.HTTP_403_FORBIDDEN,
                )
            return match

        if len(workspaces) == 1:
            # No question to ask. The commonest case for a customer-facing login, and making
            # the user confirm a list of one would be ceremony.
            return workspaces[0]

        # A choice, not an error -- so a 200 with the list rather than a 4xx. Sorted by name so
        # a person in two hundred workspaces gets something they can scan.
        return Response(
            {
                "needsChoice": True,
                "workspaces": sorted(workspaces, key=lambda entry: entry["name"].lower()),
            },
            status=status.HTTP_200_OK,
        )

    def delete(self, request):
        session = request.user.session
        workspace_slug = session.workspace_slug
        # Delete the row, not just the cookie: that removes the encrypted token
        # from the database rather than leaving it orphaned.
        session.delete()
        logger.info("Ended session for workspace %s", workspace_slug)

        response = Response(status=status.HTTP_204_NO_CONTENT)
        response.delete_cookie(settings.WORKSPACE_SESSION_COOKIE, path="/")
        return response


@method_decorator(csrf_protect, name="post")
class AnonymousSessionView(APIView):
    """
    Start a tokenless session, so the canvas is usable before anyone connects.

    Open by necessity -- there is nothing to authenticate against yet -- but it
    grants nothing: the row it creates has no token, and `HasWorkspaceSession`
    (the project default) rejects it everywhere. All it buys is a scope to save
    diagrams into.

    Idempotent for a caller who already has any session, including a connected
    one. Minting a second scope would leave the first one's diagrams stranded
    behind a cookie that no longer exists, and a double-mount or a stray retry in
    the SPA is exactly how that would happen.
    """

    permission_classes = [AllowAny]

    def post(self, request):
        if isinstance(request.user, WorkspacePrincipal):
            session = request.user.session
            return Response(
                {
                    "workspace": (
                        WorkspaceSerializer(session).data if request.user.has_token else None
                    ),
                    "connected": request.user.has_token,
                    "anonymous": not request.user.has_token,
                },
                status=status.HTTP_200_OK,
            )

        session = WorkspaceSession.start_anonymous()
        logger.info("Started anonymous session scope %s", session.workspace_id)
        return set_session_cookie(
            Response(
                {"workspace": None, "connected": False, "anonymous": True},
                status=status.HTTP_201_CREATED,
            ),
            session,
        )


class HealthView(APIView):
    permission_classes = [AllowAny]

    def get(self, request):
        return Response({"status": "ok"})
