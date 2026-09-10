"""
Settings shared by every environment.

Environment-specific modules (dev.py, prod.py) import * from here and override.
"""

from pathlib import Path

import environ

BASE_DIR = Path(__file__).resolve().parent.parent.parent

env = environ.Env()
# Read .env if present. Render supplies real env vars, so a missing file is fine.
environ.Env.read_env(BASE_DIR / ".env")

SECRET_KEY = env("SECRET_KEY", default="dev-only-insecure-key")
DEBUG = env.bool("DEBUG", default=False)
ALLOWED_HOSTS = env.list("ALLOWED_HOSTS", default=["localhost", "127.0.0.1"])

INSTALLED_APPS = [
    "django.contrib.contenttypes",
    "django.contrib.staticfiles",
    "django.contrib.postgres",  # ArrayField lookups on CatalogComponent.categories
    "rest_framework",
    "apps.auth_workspace",
    "apps.catalog",
    "apps.diagrams",
    "apps.feedback",
    "apps.nuances",
]

# django.contrib.auth is deliberately absent: this app has no user accounts.
# The Segment Public API token is the identity -- see apps/auth_workspace/.

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "static" / "spa"],
        "APP_DIRS": False,
        "OPTIONS": {"context_processors": []},
    },
]

WSGI_APPLICATION = "config.wsgi.application"

DATABASES = {
    "default": env.db(
        "DATABASE_URL",
        default="postgres://postgres:dev@localhost:5432/segarch",
    )
}
DATABASES["default"]["CONN_MAX_AGE"] = 60

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = False
USE_TZ = True

# --- Static files -----------------------------------------------------------
# The Vite build lands in static/spa/ and is served by WhiteNoise from the same
# origin as /api/*. Same-origin is load-bearing: the session cookie could not be
# SameSite=Lax across two *.onrender.com services, because onrender.com is on
# the Public Suffix List.
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STATICFILES_DIRS = [BASE_DIR / "static" / "spa"] if (BASE_DIR / "static" / "spa").exists() else []
# Compressed but *not* manifest: Vite already content-hashes every asset
# filename, so Django re-hashing them would only add a post-processing pass that
# can fail on url() references Vite emits for fonts.
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedStaticFilesStorage"},
}

# --- DRF --------------------------------------------------------------------
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "apps.auth_workspace.authentication.WorkspaceSessionAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "apps.auth_workspace.permissions.HasWorkspaceSession",
    ],
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "EXCEPTION_HANDLER": "apps.segmentapi.exceptions.segment_exception_handler",
    "UNAUTHENTICATED_USER": None,
}

# --- Session / cookie -------------------------------------------------------
WORKSPACE_SESSION_COOKIE = "sab_session"
WORKSPACE_SESSION_IDLE_HOURS = env.int("WORKSPACE_SESSION_IDLE_HOURS", default=12)

# Comma-separated Fernet keys, newest first, wrapped in MultiFernet so a key can
# be rotated without invalidating existing ciphertext.
SEGMENT_TOKEN_ENCRYPTION_KEYS = env.list("SEGMENT_TOKEN_ENCRYPTION_KEYS", default=[])

# --- Segment API ------------------------------------------------------------
SEGMENT_API_BASE_URLS = {
    "us": "https://api.segmentapis.com",
    "eu": "https://eu1.api.segmentapis.com",
}
SEGMENT_PROFILE_API_BASE = "https://profiles.segment.com/v1"

# The global catalog is workspace-independent, but reading it still needs *a*
# token. This one is ours, used only by `manage.py sync_catalog` on deploy -- it
# is never a customer token and never touches customer data. Optional: without
# it, sync_catalog falls back to borrowing an existing session's token.
SEGMENT_CATALOG_TOKEN = env("SEGMENT_CATALOG_TOKEN", default="")
SEGMENT_CATALOG_REGION = env("SEGMENT_CATALOG_REGION", default="us")

# --- Airtable (the feedback form) -------------------------------------------
#
# A personal access token with `data.records:write` and `schema.bases:read`.
#
# It lives here and *only* here, server-side, and the form posts to this app rather than to Airtable.
# That is the whole reason `apps/feedback` exists as a backend endpoint at all: a token with
# `data.records:write` in a frontend bundle is a token anyone who opens the network tab can use to
# write to -- and, with `schema.bases:read`, enumerate -- the base. There is no such thing as a
# browser-safe write token.
#
# Empty is a supported state, not a misconfiguration: the feedback form is simply unavailable, and the
# UI says so rather than offering a form whose submit fails.
AIRTABLE_API_KEY = env("AIRTABLE_API_KEY", default="")
# Which base and table. Discoverable with `manage.py airtable_schema`, which is also what confirms the
# field names this app writes to.
AIRTABLE_BASE_ID = env("AIRTABLE_BASE_ID", default="")
AIRTABLE_TABLE = env("AIRTABLE_TABLE", default="Feedback")

# What this app calls itself in the `App` field, so one base can collect feedback from several tools.
AIRTABLE_APP_NAME = env("AIRTABLE_APP_NAME", default="Segment Archistrator")

# Cache TTLs, in seconds. Space Schema is capped at 25 req/min, so it gets a
# much longer TTL than the general workspace resources.
WORKSPACE_CACHE_TTL = 300
SPACE_SCHEMA_CACHE_TTL = 3600

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {"simple": {"format": "%(levelname)s %(name)s %(message)s"}},
    "handlers": {"console": {"class": "logging.StreamHandler", "formatter": "simple"}},
    "root": {"handlers": ["console"], "level": "INFO"},
    "loggers": {
        "apps": {"handlers": ["console"], "level": "DEBUG", "propagate": False},
    },
}
