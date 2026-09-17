"""
Root URL configuration.

`/api/*` is the JSON surface; everything else falls through to the SPA's
index.html so client-side routing works on a hard refresh. Both are served from
the same origin, which is what lets the session cookie stay SameSite=Lax --
see the note in config/settings/base.py.
"""

from django.http import HttpResponse
from django.urls import include, path, re_path
from django.views.decorators.csrf import ensure_csrf_cookie

from django.conf import settings


@ensure_csrf_cookie
def spa_index(request):
    """
    Serve the built SPA shell.

    ensure_csrf_cookie means the first page load plants the csrftoken cookie, so
    the app can POST /api/session without a separate bootstrap round trip.

    Never cached, and that is the whole reason this function has cache headers at all.
    Vite content-hashes every asset filename and builds with `emptyOutDir`, so a
    rebuild replaces `assets/index-<hash>.css` with a differently-named file and
    deletes the old one. A browser holding a cached copy of *this* document then asks
    for a hash that no longer exists and gets a 404 -- the app loads with no styles, or
    no script, and nothing on screen says why. The hashed assets under /static/ stay
    freely cacheable; the one document that names them must not be.
    """
    index = settings.BASE_DIR / "static" / "spa" / "index.html"
    if not index.exists():
        return _uncached(
            HttpResponse(
                "<h1>Frontend not built</h1>"
                "<p>Run <code>cd frontend &amp;&amp; npm run build</code>, or use the Vite "
                "dev server at <a href='http://localhost:5177'>localhost:5177</a> "
                "which proxies <code>/api</code> here.</p>",
                status=503,
                content_type="text/html",
            )
        )
    return _uncached(HttpResponse(index.read_text(), content_type="text/html"))


def _uncached(response):
    """
    Tell every cache between here and the browser not to keep this.

    `no-store` is the one that matters; the other two are for intermediaries old
    enough not to honour it, which on a corporate network is not a hypothetical.
    """
    response["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response["Pragma"] = "no-cache"
    response["Expires"] = "0"
    return response


urlpatterns = [
    path("api/", include("apps.accounts.urls")),
    path("api/", include("apps.auth_workspace.urls")),
    path("api/", include("apps.catalog.urls")),
    path("api/", include("apps.feedback.urls")),
    path("api/", include("apps.diagrams.urls")),
    path("api/", include("apps.nuances.urls")),
    # Catch-all for client-side routes. Must stay last, and must not shadow
    # /static/ (WhiteNoise handles that before URL resolution).
    re_path(r"^(?!static/|api/).*$", spa_index, name="spa"),
]
