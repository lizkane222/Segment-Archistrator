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
from django.views.generic import TemplateView

from django.conf import settings


@ensure_csrf_cookie
def spa_index(request):
    """
    Serve the built SPA shell.

    ensure_csrf_cookie means the first page load plants the csrftoken cookie, so
    the app can POST /api/session without a separate bootstrap round trip.
    """
    index = settings.BASE_DIR / "static" / "spa" / "index.html"
    if not index.exists():
        return HttpResponse(
            "<h1>Frontend not built</h1>"
            "<p>Run <code>cd frontend &amp;&amp; npm run build</code>, or use the Vite "
            "dev server at <a href='http://localhost:5177'>localhost:5177</a> "
            "which proxies <code>/api</code> here.</p>",
            status=503,
            content_type="text/html",
        )
    return HttpResponse(index.read_text(), content_type="text/html")


urlpatterns = [
    path("api/", include("apps.auth_workspace.urls")),
    path("api/", include("apps.catalog.urls")),
    path("api/", include("apps.feedback.urls")),
    path("api/", include("apps.diagrams.urls")),
    path("api/", include("apps.nuances.urls")),
    # Catch-all for client-side routes. Must stay last, and must not shadow
    # /static/ (WhiteNoise handles that before URL resolution).
    re_path(r"^(?!static/|api/).*$", spa_index, name="spa"),
]
