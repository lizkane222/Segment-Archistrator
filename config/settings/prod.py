"""Production settings."""

from django.core.exceptions import ImproperlyConfigured

from .base import *  # noqa: F403
from .base import ALLOWED_EMAIL_DOMAINS, SEGMENT_TOKEN_ENCRYPTION_KEYS, env

DEBUG = False

# Keep localhost out of prod.
ALLOWED_HOSTS = env.list("ALLOWED_HOSTS", default=[])

CSRF_TRUSTED_ORIGINS = [f"https://{h}" for h in ALLOWED_HOSTS if h]

# CloudFront's Viewer Protocol Policy ("Redirect HTTP to HTTPS") already
# guarantees that every request reaching this app came from a real HTTPS
# connection to the viewer -- Django doesn't need to (and here, can't)
# independently verify that per request. CloudFront strips the standard
# X-Forwarded-Proto header unconditionally for every custom origin, no
# exceptions, and the one header it does support for this
# (CloudFront-Forwarded-Proto) only reaches a custom origin via a *custom*
# origin request policy -- a feature AWS gates behind the $200/month
# CloudFront Business plan, which is wildly disproportionate for this app.
#
# So: no redirect at the Django layer (CloudFront already did it, and a
# broken redirect here previously looped the site forever), and no per-request
# scheme detection -- just hardcode what's structurally always true instead.
# Because request.is_secure() can never be confirmed True, Django's
# SecurityMiddleware will never actually emit the HSTS header regardless of
# SECURE_HSTS_SECONDS, so there's no point setting it above 0.
SECURE_SSL_REDIRECT = False
SECURE_HSTS_SECONDS = 0
SECURE_HSTS_INCLUDE_SUBDOMAINS = False
SECURE_HSTS_PRELOAD = False
SECURE_CONTENT_TYPE_NOSNIFF = True
# Unlike HSTS, these aren't gated on request.is_secure() -- they're applied to
# every Set-Cookie regardless, so hardcoding True here is both safe and
# actually takes effect.
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
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
