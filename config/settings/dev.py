"""Local development settings."""

from cryptography.fernet import Fernet

from .base import *  # noqa: F403
from .base import SEGMENT_TOKEN_ENCRYPTION_KEYS

DEBUG = True
ALLOWED_HOSTS = ["localhost", "127.0.0.1", "[::1]"]

# Vite dev server runs on :5177 and proxies /api to :8000, so requests are
# same-origin from the browser's perspective and no CORS setup is needed.
CSRF_TRUSTED_ORIGINS = ["http://localhost:5177", "http://127.0.0.1:5177"]

SESSION_COOKIE_SECURE = False
CSRF_COOKIE_SECURE = False

# Convenience only: in dev an ephemeral key is generated when none is configured,
# so `runserver` works on a fresh clone. Sessions do not survive a restart.
# prod.py refuses to boot without a real key.
if not SEGMENT_TOKEN_ENCRYPTION_KEYS:
    SEGMENT_TOKEN_ENCRYPTION_KEYS = [Fernet.generate_key().decode()]
    print(
        "\n  [dev] SEGMENT_TOKEN_ENCRYPTION_KEYS is unset -- generated an "
        "ephemeral key.\n        Stored workspace sessions will not survive a "
        "restart. Set the var in .env to persist them.\n"
    )
