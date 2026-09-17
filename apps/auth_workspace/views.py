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

from apps.accounts import google
from apps.accounts.serializers import AccountSerializer
from apps.diagrams.models import Diagram
from apps.segmentapi.client import SegmentClient
from apps.segmentapi.exceptions import SegmentAuthError, SegmentError
from apps.segmentapi.graphql import SegmentGraphQLClient

from .authentication import WorkspacePrincipal
from .models import OperatorWorkspaceBookmark, WorkspaceSession
from .permissions import AllowAny, HasSession
from .serializers import StartSessionSerializer, WorkspaceSerializer

logger = logging.getLogger(__name__)

# Segment's own internal tooling workspaces. These carry no signal for anyone
# diagramming a customer's architecture and must never appear in the picker, no
# matter what the token can see -- unconditionally, unlike `_OPERATOR_SLUG` below.
_HIDDEN_GRAPHQL_SLUGS = {"segment-admin", "segment-engineering", "segment"}

# Segment's operator tooling workspace. Unlike the three above, it is shown in the
# list like any other workspace -- but clicking it does not connect to it. It has no
# fixed set of customer workspaces of its own; instead it is a gateway that asks for
# the exact slug of the workspace actually wanted, so that a token which can reach
# every customer via the operator tool does not get to list them all.
_OPERATOR_SLUG = "segment-operator"


def session_payload(session):
    """
    What "who am I" looks like on the wire, built in exactly one place.

    Every endpoint that hands the browser a session answers with this shape -- the boot
    read, minting an anonymous scope, and logging out. It used to be assembled inline in
    each, and they drifted: `POST /api/session/anonymous` replied without `hasSession`, so
    the SPA read a session it had just been given as no session at all and the sign-in
    button disappeared.

    `session` may be None, meaning no usable cookie.
    """
    connected = bool(session and session.has_token)
    account = session.account if session else None
    return {
        # The field the client branches on. `connected` and `anonymous` are descriptive
        # and can now both be false at once -- someone signed in who has not connected a
        # workspace -- so neither of them can answer "does a session exist".
        "hasSession": session is not None,
        "account": AccountSerializer(account).data if account else None,
        "workspace": WorkspaceSerializer(session).data if connected else None,
        "connected": connected,
        "anonymous": bool(session) and not connected,
        # So the header does not draw a sign-in button on a deployment that has no Google
        # client configured and could not honour the click.
        "auth": {"google": google.is_configured()},
    }


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
        # HasSession, not HasWorkspaceSession. The stricter class additionally requires
        # a credential that can read the Public API, which meant a tokenless scope and
        # an app-session (auth_token) connection could not be disconnected at all -- a
        # 403 on the one verb whose whole job is to let go of a session.
        return [HasSession()]

    def get(self, request):
        authenticated = request.user is not None and getattr(
            request.user, "is_authenticated", False
        )
        session = request.user.session if authenticated else None
        return Response(session_payload(session), status=status.HTTP_200_OK)

    def post(self, request):
        serializer = StartSessionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        token = serializer.validated_data["token"]
        region = serializer.validated_data["region"]
        credential = serializer.validated_data["credential"]
        chosen = (serializer.validated_data.get("workspace_id") or "").strip()
        chosen_slug = (serializer.validated_data.get("workspace_slug") or "").strip()

        # Read the outgoing session before it is replaced. Holding this cookie is
        # the only proof of ownership over an anonymous scope, so the claim has to
        # be decided here, on this request, and never from anything the client says.
        # Hoisted above the credential branch: the GraphQL path needs to know the
        # account too, both to gate on its email and to merge/save its bookmarks.
        outgoing = request.user if isinstance(request.user, WorkspacePrincipal) else None
        anonymous_scope = outgoing.anon_scope if outgoing is not None else None
        # Carried onto the new row, so signing in later can still claim what was drawn
        # before either step happened. Connecting a credential is about the *subject* of
        # a diagram now, not about who owns it, so the scope must survive.
        carried_account = outgoing.account if outgoing is not None else None

        # Two ways in, and the app has no preference between them -- the caller says which it
        # is bringing. What differs is only how the workspace is derived: a Public API token
        # belongs to one workspace and `GET /` names it; an auth_token is a person, so the
        # workspace is a choice that may need asking about first.
        if credential == WorkspaceSession.CREDENTIAL_GRAPHQL:
            # A person's `auth_token` is their whole login session, not a scoped credential --
            # the frontend hides this tab from anyone but a signed-in `@twilio.com` account, and
            # this repeats the check server-side since the tab being hidden is not the same
            # thing as the API refusing it.
            if not (carried_account and carried_account.email.endswith("@twilio.com")):
                return Response(
                    {
                        "error": {
                            "code": "graphql_not_allowed",
                            "message": "App session connections are limited to Twilio accounts.",
                        }
                    },
                    status=status.HTTP_403_FORBIDDEN,
                )
            outcome = self._workspace_from_graphql(
                token,
                region=region,
                chosen=chosen,
                chosen_slug=chosen_slug,
                account=carried_account,
            )
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

        with transaction.atomic():
            session = WorkspaceSession.start(
                token=token,
                workspace=workspace,
                region=region,
                credential_kind=credential,
                account=carried_account,
                anon_scope=anonymous_scope or "",
            )
            claimed = 0
            if anonymous_scope:
                # Retag, not reassign: what changes is which workspace these diagrams
                # are *about*. Who may see them is unchanged -- they stay under the same
                # anonymous scope, which the new row carries -- because connecting a
                # credential says nothing about who someone is.
                claimed = Diagram.objects.filter(
                    anon_scope=anonymous_scope, workspace_id=""
                ).update(workspace_id=session.workspace_id)
                # Drop any other row naming this scope. The cookie about to be
                # overwritten pointed at one of them, and leaving the rest behind would
                # only accumulate dead sessions.
                WorkspaceSession.objects.filter(anon_scope=anonymous_scope).exclude(
                    pk=session.pk
                ).delete()

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

    def _workspace_from_graphql(self, token, *, region, chosen, chosen_slug, account):
        client = SegmentGraphQLClient(token, region=region)
        try:
            raw = client.list_workspaces()
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

        # Segment's own tooling workspaces carry no signal for diagramming a customer's
        # architecture and are never shown, no matter what the token can see.
        # `segment-operator` is the one exception -- it stays, but only as a gateway (below).
        visible = [entry for entry in raw if entry["slug"] not in _HIDDEN_GRAPHQL_SLUGS]
        raw_ids = {entry["id"] for entry in raw}

        # This account's previously-resolved operator slugs, folded into the list so they
        # do not have to be retyped on every later connect. Skipped for an anonymous caller:
        # there is no account to save them under, so a resolved slug is good for this attempt
        # only -- see the module docstring on `OperatorWorkspaceBookmark`.
        bookmarks = (
            OperatorWorkspaceBookmark.objects.filter(account=account) if account else []
        )
        merged = list(visible)
        bookmark_ids = set()
        for bookmark in bookmarks:
            if bookmark.workspace_id in raw_ids:
                continue
            merged.append(
                {
                    "id": bookmark.workspace_id,
                    "slug": bookmark.slug,
                    "name": bookmark.workspace_name,
                    "region": bookmark.region,
                }
            )
            bookmark_ids.add(bookmark.workspace_id)

        def sorted_list():
            return sorted(merged, key=lambda entry: entry["name"].lower())

        if chosen_slug:
            # The second step of the `segment-operator` gateway: resolve the exact slug typed,
            # rather than the id of the gateway entry itself.
            try:
                resolved = client.get_workspace_by_slug(chosen_slug)
            except SegmentAuthError as err:
                return Response(
                    {"error": {"code": "workspace_not_visible", "message": str(err)}},
                    status=status.HTTP_403_FORBIDDEN,
                )
            except SegmentError as err:
                logger.info("Segment GraphQL gateway error while resolving a slug: %s", err)
                return Response(
                    {"error": {"code": "graphql_error", "message": str(err)}},
                    status=status.HTTP_502_BAD_GATEWAY,
                )
            if account:
                OperatorWorkspaceBookmark.objects.update_or_create(
                    account=account,
                    slug=resolved["slug"],
                    defaults={
                        "workspace_id": resolved["id"],
                        "workspace_name": resolved["name"],
                        "region": resolved["region"],
                    },
                )
            if resolved["id"] not in {entry["id"] for entry in merged}:
                merged.append(resolved)
            # Re-present the choice rather than connecting outright -- the user asked to add
            # this workspace to their list, and picking it is still a separate, deliberate click.
            return Response(
                {"needsChoice": True, "workspaces": sorted_list()}, status=status.HTTP_200_OK
            )

        if chosen:
            operator_entry = next(
                (entry for entry in merged if entry["slug"] == _OPERATOR_SLUG), None
            )
            if operator_entry is not None and operator_entry["id"] == chosen:
                # Not a workspace to connect to -- a prompt to type the real one.
                return Response(
                    {"needsSlug": True, "workspaces": sorted_list()}, status=status.HTTP_200_OK
                )

            match = next((entry for entry in merged if entry["id"] == chosen), None)
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
                                f"see {len(merged)}. Try connecting again."
                            ),
                        }
                    },
                    status=status.HTTP_403_FORBIDDEN,
                )

            if match["id"] in bookmark_ids:
                # A bookmark is cached data, not authorization: the token attached to *this*
                # request may no longer reach the workspace it once resolved, so the bookmark
                # is re-verified live rather than trusted to connect on its own say.
                try:
                    return client.get_workspace_by_slug(match["slug"])
                except SegmentAuthError as err:
                    return Response(
                        {"error": {"code": "workspace_not_visible", "message": str(err)}},
                        status=status.HTTP_403_FORBIDDEN,
                    )
                except SegmentError as err:
                    logger.info(
                        "Segment GraphQL gateway error while re-verifying a bookmark: %s", err
                    )
                    return Response(
                        {"error": {"code": "graphql_error", "message": str(err)}},
                        status=status.HTTP_502_BAD_GATEWAY,
                    )
            return match

        if len(merged) == 1 and merged[0]["slug"] != _OPERATOR_SLUG:
            # No question to ask. The commonest case for a customer-facing login, and making
            # the user confirm a list of one would be ceremony. Excludes the operator gateway:
            # being the only entry visible is not the same as being connectable.
            return merged[0]

        # A choice, not an error -- so a 200 with the list rather than a 4xx. Sorted by name so
        # a person in two hundred workspaces gets something they can scan.
        return Response(
            {"needsChoice": True, "workspaces": sorted_list()}, status=status.HTTP_200_OK
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
            return Response(session_payload(request.user.session), status=status.HTTP_200_OK)

        session = WorkspaceSession.start_anonymous()
        logger.info("Started anonymous session scope %s", session.anon_scope)
        return set_session_cookie(
            Response(
                session_payload(session),
                status=status.HTTP_201_CREATED,
            ),
            session,
        )


class HealthView(APIView):
    permission_classes = [AllowAny]

    def get(self, request):
        return Response({"status": "ok"})
