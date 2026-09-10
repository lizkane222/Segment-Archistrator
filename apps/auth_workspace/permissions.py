from rest_framework import permissions

from .authentication import WorkspacePrincipal


class HasWorkspaceSession(permissions.BasePermission):
    """
    Require a session whose credential can actually read the Public API.

    This is the project-wide default (DEFAULT_PERMISSION_CLASSES), and every view that reaches
    for `SegmentClient` gets it without asking. That is deliberate and is the same reason write
    keys are masked in serializers rather than in views: the safe behaviour has to be the one
    you get by not thinking about it.

    Two kinds of session are refused here, for two different reasons:

      - A *tokenless* (anonymous) session, which has no credential at all.
      - A session connected with an app `auth_token` rather than a Public API token. That
        credential authenticates and names the workspace, but none of the thirty-six Public API
        endpoints in `apps/segmentapi/endpoints.py` have GraphQL equivalents written yet, so
        sending it at `api.segmentapis.com` would produce a 401 from Segment that looks like a
        bad token rather than an unfinished feature. `can_read_workspace_api` is the one place
        that distinction lives; when the GraphQL reads exist, it is the only thing to change.

    Both are refused with 403, not 401. The status is DRF's own doing -- the caller *is*
    authenticated, it simply has no authority here -- and it is also what the SPA needs: 401
    makes it re-bootstrap the session, which on an anonymous scope would throw away the cookie
    the visitor's unsaved diagrams are scoped to.

    The two get different codes, because the fix is different: one is "connect something", the
    other is "connect the other thing". A single message covering both would tell a user who
    has *already* connected a workspace to go and connect a workspace.
    """

    message = "Connect a workspace with a Segment Public API token to read this."
    code = "workspace_not_connected"

    def has_permission(self, request, view):
        if not isinstance(request.user, WorkspacePrincipal):
            return False
        if not request.user.has_token:
            return False
        if not request.user.session.can_read_workspace_api:
            self.message = (
                "This workspace was connected with an app session (auth_token), which "
                "identifies the workspace but cannot read its components yet. Connect a "
                "Segment Public API token to load sources, destinations and audiences."
            )
            self.code = "credential_cannot_read_workspace"
            return False
        return True


class HasAnyWorkspaceCredential(permissions.BasePermission):
    """
    A session with *some* credential for a real workspace, whichever kind.

    The opposite end of `HasWorkspaceSession` from `HasSession`: it still refuses an anonymous scope,
    but it accepts a session connected with an app `auth_token` as well as one with a Public API token.

    Used by exactly one view -- the workspace graph -- and that narrowness is the point. The default
    stays Public-API-only so a view added next year is safe without anyone thinking about it, and a
    view that has genuinely handled both credentials opts in here. Anything using this has to branch
    on `session.can_read_workspace_api` itself; the permission only says a credential exists, not that
    the Public API will accept it.
    """

    message = "Connect a workspace to read this."
    code = "workspace_not_connected"

    def has_permission(self, request, view):
        return isinstance(request.user, WorkspacePrincipal) and request.user.has_token


class HasSession(permissions.BasePermission):
    """
    Any resolved session, connected or not.

    For resources scoped by `workspace_id` that hold no Segment data of their own
    -- diagrams. An anonymous session's synthetic workspace_id scopes it to itself
    exactly as a real one does, so the views need no special case; what they must
    not do is call the Segment API, which `reveal_token` refuses anyway.
    """

    message = "A session is required. Reload the page to start one."

    def has_permission(self, request, view):
        return isinstance(request.user, WorkspacePrincipal)


class AllowAny(permissions.AllowAny):
    """Re-exported so views can opt out without importing from DRF directly."""
