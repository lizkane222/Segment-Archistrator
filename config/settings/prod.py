"""Production settings."""

from django.core.exceptions import ImproperlyConfigured

from .base import *  # noqa: F403
from .base import SEGMENT_TOKEN_ENCRYPTION_KEYS, env

DEBUG = False

# Render injects the external hostname. Keep localhost out of prod.
ALLOWED_HOSTS = env.list("ALLOWED_HOSTS", default=[])
_render_host = env("RENDER_EXTERNAL_HOSTNAME", default="")
if _render_host:
    ALLOWED_HOSTS.append(_render_host)

CSRF_TRUSTED_ORIGINS = [f"https://{h}" for h in ALLOWED_HOSTS if h]

# True whenever the proxy in front of this app terminates TLS (Render always
# does, even on free URLs; an AWS load balancer only does once it has an HTTPS
# listener + cert, which needs a domain). Until that's in place, forcing these
# on would either redirect-loop every request or stop the browser from sending
# the session cookie back at all -- so this is env-driven, not hard-coded.
# Flip it back to default (true) the moment HTTPS is in front of this app.
_HTTPS_AVAILABLE = env.bool("SECURE_SSL_REDIRECT", default=True)

SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = _HTTPS_AVAILABLE
SECURE_HSTS_SECONDS = 31536000 if _HTTPS_AVAILABLE else 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = _HTTPS_AVAILABLE
SECURE_HSTS_PRELOAD = _HTTPS_AVAILABLE
SECURE_CONTENT_TYPE_NOSNIFF = True
SESSION_COOKIE_SECURE = _HTTPS_AVAILABLE
CSRF_COOKIE_SECURE = _HTTPS_AVAILABLE
X_FRAME_OPTIONS = "DENY"

# A missing encryption key in prod would mean tokens stored under a throwaway
# key -- unreadable after restart, and silently so. Fail loudly at boot instead.
if not SEGMENT_TOKEN_ENCRYPTION_KEYS:
    raise ImproperlyConfigured(
        "SEGMENT_TOKEN_ENCRYPTION_KEYS must be set in production. "
        "Generate one with: python -c \"from cryptography.fernet import Fernet; "
        'print(Fernet.generate_key().decode())"'
    )
