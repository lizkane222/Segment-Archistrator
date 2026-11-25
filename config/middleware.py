"""
Response headers that Django's SecurityMiddleware does not set.

Two jobs:

  - A Content-Security-Policy on the HTML document. The app compiles a function node's code
    with `new Function`, which needs `'unsafe-eval'` and so rules out the strongest thing a CSP
    does (refusing injected script). What it still buys, and why it is worth having here, is
    containment: `connect-src 'self'` means code that does run cannot send anything to another
    host, `frame-ancestors 'none'` and `base-uri`/`form-action` close the clickjacking and
    redirect tricks, and `object-src 'none'` removes plugins.

  - `Cache-Control: no-store` on every `/api/` response. The API answers differently per
    cookie, and the app is reached through a corporate proxy (Zscaler) that may cache what it
    sees. A cached `GET /api/diagrams` served to the next person would be a data leak, so the
    API says in so many words that nothing in it is to be kept.
"""

from django.conf import settings

CSP_DIRECTIVES = {
    "default-src": ["'self'"],
    # 'unsafe-eval' is the function runtime's `new Function` -- see the module docstring.
    "script-src": ["'self'", "'unsafe-eval'"],
    # React and React Flow position everything with inline `style` attributes.
    "style-src": ["'self'", "'unsafe-inline'"],
    # Logos are hosted by Segment's CDN, which is not a fixed list of hosts; `blob:`/`data:` are
    # image export and pasted pictures.
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'"],
    "worker-src": ["'self'", "blob:"],
    "object-src": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "frame-ancestors": ["'none'"],
}


def build_csp() -> str:
    return "; ".join(f"{name} {' '.join(values)}" for name, values in CSP_DIRECTIVES.items())


class SecurityHeadersMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response
        self.csp = build_csp()

    def __call__(self, request):
        response = self.get_response(request)

        if request.path.startswith("/api/"):
            response["Cache-Control"] = "no-store"
            response["Pragma"] = "no-cache"
            # Defence in depth for caches that ignore no-store.
            response["Vary"] = ", ".join(
                dict.fromkeys([*(response.get("Vary", "").split(", ")), "Cookie"]).keys() - {""}
            )

        if response.get("Content-Type", "").startswith("text/html"):
            header = (
                "Content-Security-Policy-Report-Only"
                if getattr(settings, "CSP_REPORT_ONLY", False)
                else "Content-Security-Policy"
            )
            response[header] = self.csp
            response["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=()"
        return response


class HealthCheckMiddleware:
    """
    Answer the load balancer's health check before anything can object to it.

    Two things would otherwise make a perfectly healthy instance look dead:

      - The check arrives with the instance's own IP as `Host`, which is not in
        ALLOWED_HOSTS, so Django answers 400.
      - Once HTTPS is switched on, `SECURE_SSL_REDIRECT` answers the check -- which comes in
        over plain HTTP from inside the load balancer, with no `X-Forwarded-Proto` -- with a
        301, and EB marks the environment unhealthy.

    Must be the first middleware. It does no work and reads nothing, so there is nothing to
    protect: the body is a constant and it is the same for every caller.
    """

    path = "/api/health"

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path == self.path and request.method in ("GET", "HEAD"):
            from django.http import HttpResponse

            response = HttpResponse('{"status": "ok"}', content_type="application/json")
            response["Cache-Control"] = "no-store"
            return response
        return self.get_response(request)
