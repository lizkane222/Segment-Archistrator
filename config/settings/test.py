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

# Silence the request/exception log noise that deliberate 4xx tests produce.
LOGGING["root"]["level"] = "ERROR"  # noqa: F405
LOGGING["loggers"]["apps"]["level"] = "ERROR"  # noqa: F405
