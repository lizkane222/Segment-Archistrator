"""
The one place the session cookie's attributes are decided.

Written out twice before (once in `views.set_session_cookie`, once in the sliding-expiry
middleware), and both hard-coded `secure=not DEBUG`. That ignored `SESSION_COOKIE_SECURE`,
which prod.py ties to whether HTTPS is actually in front of the app -- so an HTTP-only
deployment was told to send a `Secure` cookie the browser would then refuse to store,
and the knob that is meant to govern it governed nothing.
"""

from django.conf import settings


def set_session_cookie_on(response, session_id):
    response.set_cookie(
        settings.WORKSPACE_SESSION_COOKIE,
        str(session_id),
        max_age=settings.WORKSPACE_SESSION_IDLE_HOURS * 3600,
        httponly=True,
        samesite="Lax",
        secure=settings.SESSION_COOKIE_SECURE,
        path="/",
    )
    return response
