"""
Keep an active session's cookie from expiring underneath it.

`WorkspaceSession.touch()` slides `last_seen_at` on every authenticated request, so the
*server* treats a session as alive for `WORKSPACE_SESSION_IDLE_HOURS` after the last
request. The cookie did not agree: `max_age` was written once, when the session was
created, so the browser dropped it that many hours after sign-in no matter how recently
it had been used. Someone working all day was logged out mid-afternoon and -- before
accounts existed -- lost sight of everything they had drawn.

Re-issuing the cookie on the way out is the fix, and it belongs in middleware rather
than in the authentication class because that class runs when `request.user` is first
touched, which is long before there is a response to set a cookie on.

Only requests that actually resolved a session are touched, and the value is unchanged
-- this rewrites the expiry, never the session id. Rotation is a deliberate act and
happens in the views that mean it (sign-in, sign-out).
"""

from django.conf import settings


class SlidingSessionCookieMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)

        session = getattr(request, "_workspace_session_to_refresh", None)
        if session is None:
            return response

        # Do not fight a view that has already spoken about this cookie. Sign-in,
        # sign-out and connect all set or delete it deliberately, and a blanket refresh
        # here would either resurrect a cookie DELETE just cleared or overwrite a
        # freshly rotated id with the old one.
        if settings.WORKSPACE_SESSION_COOKIE in response.cookies:
            return response

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
