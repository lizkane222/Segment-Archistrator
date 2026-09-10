"""Production settings for Render."""

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

# Render terminates TLS at its proxy.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = True
SECURE_HSTS_SECONDS = 31536000
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = True
SECURE_CONTENT_TYPE_NOSNIFF = True
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
X_FRAME_OPTIONS = "DENY"

# A missing encryption key in prod would mean tokens stored under a throwaway
# key -- unreadable after restart, and silently so. Fail loudly at boot instead.
if not SEGMENT_TOKEN_ENCRYPTION_KEYS:
    raise ImproperlyConfigured(
        "SEGMENT_TOKEN_ENCRYPTION_KEYS must be set in production. "
        "Generate one with: python -c \"from cryptography.fernet import Fernet; "
        'print(Fernet.generate_key().decode())"'
    )
