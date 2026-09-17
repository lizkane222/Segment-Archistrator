"""
Test settings.

Fixed encryption keys rather than generated ones: the key-rotation test needs to
know what the keys are, and a deterministic key makes a failure reproducible.
"""

from .base import *  # noqa: F403

DEBUG = False
ALLOWED_HOSTS = ["testserver", "localhost", "127.0.0.1"]

# Two keys, newest first, so MultiFernet rotation is exercised by default.
SEGMENT_TOKEN_ENCRYPTION_KEYS = [
    "cSHRy2W9U0YvrRT7yBn6zeqXwuDIsRV8sf3IY8Xnf7A=",
    "0Hf9dFRrTvOxAykQpBqDXczqEJ8FQ0KAaMkLHM2ZvvE=",
]

SESSION_COOKIE_SECURE = False
CSRF_COOKIE_SECURE = False

# Sign-in is *unconfigured* by default here, whatever is in the developer's .env.
#
# base.py reads these from the environment, so a machine with real Google credentials in
# .env ran a different suite from a machine without them: every test asserting the
# unconfigured behaviour -- `auth.google: false` in the session payload, the redirect
# `/api/auth/google/start` returns when it cannot honour a click -- failed, and only
# there. Pinning them empty makes unconfigured the baseline and leaves the
# `google_configured` fixture (tests/conftest.py) as the one way to opt into the
# configured case, which is the only way either state gets exercised deliberately.
GOOGLE_OAUTH_CLIENT_ID = ""
GOOGLE_OAUTH_CLIENT_SECRET = ""
GOOGLE_OAUTH_REDIRECT_URI = ""

# Same reasoning: invitation-only unless a test says otherwise, so a local
# ALLOWED_EMAIL_DOMAINS cannot quietly admit an address a test expects to be refused.
ALLOWED_EMAIL_DOMAINS = []

# Silence the request/exception log noise that deliberate 4xx tests produce.
LOGGING["root"]["level"] = "ERROR"  # noqa: F405
LOGGING["loggers"]["apps"]["level"] = "ERROR"  # noqa: F405
