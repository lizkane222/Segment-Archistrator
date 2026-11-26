"""Production settings."""

from django.core.exceptions import ImproperlyConfigured

from .base import *  # noqa: F403
from .base import ALLOWED_EMAIL_DOMAINS, SEGMENT_TOKEN_ENCRYPTION_KEYS, env

DEBUG = False

# Keep localhost out of prod.
ALLOWED_HOSTS = env.list("ALLOWED_HOSTS", default=[])

CSRF_TRUSTED_ORIGINS = [f"https://{h}" for h in ALLOWED_HOSTS if h]

# True whenever the proxy in front of this app terminates TLS (Render always
# does, even on free URLs; an AWS load balancer only does once it has an HTTPS
# listener + cert, which needs a domain). Until that's in place, forcing these
# on would either redirect-loop every request or stop the browser from sending
# the session cookie back at all -- so this is env-driven, not hard-coded.
# Flip it back to default (true) the moment HTTPS is in front of this app.
_HTTPS_AVAILABLE = env.bool("SECURE_SSL_REDIRECT", default=True)

# Not X-Forwarded-Proto: CloudFront unconditionally strips that header on
# every request to a custom origin, no exceptions -- confirmed in AWS's own
# docs. CloudFront-Forwarded-Proto is the header it actually supports for
# this, and only when explicitly enabled on the origin request policy (see
# the "forward-cloudfront-proto" policy on the distribution).
SECURE_PROXY_SSL_HEADER = ("HTTP_CLOUDFRONT_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = _HTTPS_AVAILABLE
# A year is the end state, but a browser that has seen this header will refuse plain HTTP
# for that long, so the first HTTPS deploy should set SECURE_HSTS_SECONDS=3600 and raise it
# once nothing has gone wrong.
SECURE_HSTS_SECONDS = env.int("SECURE_HSTS_SECONDS", default=31536000) if _HTTPS_AVAILABLE else 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = _HTTPS_AVAILABLE
# Not preload: that is a promise to browser vendors that is not undoable, and nobody has
# submitted this host to the list.
SECURE_HSTS_PRELOAD = False
SECURE_CONTENT_TYPE_NOSNIFF = True
SESSION_COOKIE_SECURE = _HTTPS_AVAILABLE
CSRF_COOKIE_SECURE = _HTTPS_AVAILABLE
X_FRAME_OPTIONS = "DENY"

# Not read from the environment, on purpose: this deployment is closed to anyone who has not
# signed in with an allowed Google domain, and a typo in an env var must not be able to open it.
REQUIRE_ACCOUNT = True
INVITATIONS_ENABLED = False
if not [d for d in ALLOWED_EMAIL_DOMAINS if d.strip()]:
    raise ImproperlyConfigured("ALLOWED_EMAIL_DOMAINS must name at least one domain in production.")

# A missing encryption key in prod would mean tokens stored under a throwaway
# key -- unreadable after restart, and silently so. Fail loudly at boot instead.
if not SEGMENT_TOKEN_ENCRYPTION_KEYS:
    raise ImproperlyConfigured(
        "SEGMENT_TOKEN_ENCRYPTION_KEYS must be set in production. "
        "Generate one with: python -c \"from cryptography.fernet import Fernet; "
        'print(Fernet.generate_key().decode())"'
    )
