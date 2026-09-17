"""
The Google side of sign-in: build the consent URL, exchange the code, read the identity.

No OAuth library. `requests` is already a dependency and the authorization-code flow
is two URLs and one POST; pulling in `authlib` or `django-allauth` to do that would
add a framework's worth of surface (and, in allauth's case, a dependency on
`django.contrib.auth`, which this project deliberately does not install).

## Why the id_token's signature is not verified

Verifying it would mean fetching and caching Google's JWKS and doing RSA validation.
That is required when a token arrives from somewhere you do not trust -- a browser,
another service. Here the token comes back in the body of our own HTTPS POST to
`https://oauth2.googleapis.com/token`, authenticated with our client secret. TLS
already establishes that Google sent it, which is exactly what a signature check
would establish. Google's own documentation says so: a token obtained directly from
the token endpoint may be used without validation.

So this module decodes the payload and does not pretend to authenticate it. What it
*does* check is `aud` -- that the token was minted for this client -- because that is
a claim about us that TLS cannot speak to.
"""

import base64
import hashlib
import json
import logging
import secrets
import time

import requests
from django.conf import settings

logger = logging.getLogger(__name__)

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
SCOPES = "openid email profile"
# Both spellings are legitimate and Google uses each in different places.
ISSUERS = frozenset({"accounts.google.com", "https://accounts.google.com"})

TIMEOUT = 10


def pkce_pair() -> tuple[str, str]:
    """
    A PKCE verifier and its S256 challenge.

    Not strictly required for a confidential client -- we hold a secret, so an
    intercepted code cannot be redeemed without it -- but it is six lines, it is
    Google's current recommendation regardless, and it closes the window where a code
    leaked from a redirect (a proxy log, a shoulder-surfed URL bar) is worth anything
    on its own.
    """
    verifier = secrets.token_urlsafe(64)[:128]
    digest = hashlib.sha256(verifier.encode()).digest()
    return verifier, base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


class GoogleAuthError(Exception):
    """Google refused, or answered something unusable. The message is user-facing."""


def is_configured() -> bool:
    """
    Whether sign-in can work at all.

    Checked before offering the button rather than after clicking it: an unset client
    id is a deployment that has not finished being set up, and the honest response is
    to say so, not to bounce someone to a Google error page.
    """
    return bool(settings.GOOGLE_OAUTH_CLIENT_ID and settings.GOOGLE_OAUTH_CLIENT_SECRET)


def redirect_uri(request) -> str:
    """
    Where Google sends the browser back.

    Derived from the request unless pinned by `GOOGLE_OAUTH_REDIRECT_URI`. Deriving it
    keeps localhost, a Render preview and production working from one setting, and the
    override exists because the value must match Google's console byte for byte -- and
    behind a proxy the request's own idea of its scheme can be wrong.
    """
    if settings.GOOGLE_OAUTH_REDIRECT_URI:
        return settings.GOOGLE_OAUTH_REDIRECT_URI
    return request.build_absolute_uri("/api/auth/google/callback")


def consent_url(*, state: str, redirect_to: str, code_challenge: str = "") -> str:
    """The URL to send the browser to."""
    from urllib.parse import urlencode

    params = {
        "client_id": settings.GOOGLE_OAUTH_CLIENT_ID,
        "redirect_uri": redirect_to,
        "response_type": "code",
        "scope": SCOPES,
        "state": state,
        **(
            {"code_challenge": code_challenge, "code_challenge_method": "S256"}
            if code_challenge
            else {}
        ),
        # No refresh token: this app never acts on someone's behalf at Google, it only
        # needs to learn who they are once per sign-in.
        "access_type": "online",
        # Show the chooser rather than silently reusing whichever Google account the
        # browser happens to be signed into -- people connecting customer workspaces
        # routinely have two.
        "prompt": "select_account",
    }
    return f"{AUTH_URL}?{urlencode(params)}"


def exchange_code(*, code: str, redirect_to: str, code_verifier: str = "") -> dict:
    """
    Trade the one-time code for tokens. Returns the parsed identity.

    Keys: `sub`, `email`, `email_verified`, `name`, `picture`.
    """
    try:
        response = requests.post(
            TOKEN_URL,
            data={
                "code": code,
                "client_id": settings.GOOGLE_OAUTH_CLIENT_ID,
                "client_secret": settings.GOOGLE_OAUTH_CLIENT_SECRET,
                "redirect_uri": redirect_to,
                "grant_type": "authorization_code",
                **({"code_verifier": code_verifier} if code_verifier else {}),
            },
            timeout=TIMEOUT,
        )
    except requests.RequestException as err:
        # A network fault, not a rejection. Said differently so the caller does not
        # tell someone their sign-in was denied when Google was simply unreachable.
        raise GoogleAuthError("Could not reach Google to complete sign-in.") from err

    if response.status_code != 200:
        # Deliberately does not echo Google's body: it can contain the code and the
        # client id, and this string reaches a URL.
        logger.info("Google token endpoint returned %s", response.status_code)
        raise GoogleAuthError("Google would not complete that sign-in. Try again.")

    try:
        payload = response.json()
    except ValueError as err:
        raise GoogleAuthError("Google returned an unreadable response.") from err

    id_token = payload.get("id_token")
    if not id_token:
        raise GoogleAuthError("Google's response carried no identity.")

    return identity_from_id_token(id_token)


def identity_from_id_token(id_token: str) -> dict:
    """
    Read the claims out of a JWT without verifying it -- see the module docstring.

    Split out so tests can build an id_token by hand: the signature segment is never
    looked at, so a test does not need a key pair to exercise the whole flow.
    """
    claims = _decode_payload(id_token)

    # The claims are checked even though the signature is not. They are free, and each
    # catches something TLS cannot speak to -- `aud` in particular catches a client id
    # copied from another Google project, which would otherwise let that project's
    # users sign in here.
    if claims.get("iss") not in ISSUERS:
        logger.warning("Rejected an id_token with issuer %r", claims.get("iss"))
        raise GoogleAuthError("That identity token was not issued by Google.")

    audience = claims.get("aud")
    if settings.GOOGLE_OAUTH_CLIENT_ID and audience != settings.GOOGLE_OAUTH_CLIENT_ID:
        logger.warning("Rejected an id_token issued for a different client")
        raise GoogleAuthError("That sign-in was issued for a different application.")

    try:
        expires_at = int(claims.get("exp") or 0)
    except (TypeError, ValueError):
        expires_at = 0
    if expires_at <= int(time.time()):
        raise GoogleAuthError("That sign-in expired before it completed. Try again.")

    email = claims.get("email") or ""
    subject = claims.get("sub") or ""
    if not email or not subject:
        raise GoogleAuthError("Google did not return an email address for that account.")

    verified = claims.get("email_verified")
    # Google sends a real boolean, but the claim is a string in some older responses.
    if isinstance(verified, str):
        verified = verified.lower() == "true"

    return {
        "sub": subject,
        "email": email,
        "email_verified": bool(verified),
        "name": claims.get("name") or "",
        "picture": claims.get("picture") or "",
    }


def _decode_payload(id_token: str) -> dict:
    try:
        _, payload, _ = id_token.split(".")
    except ValueError as err:
        raise GoogleAuthError("Google returned a malformed identity token.") from err

    # JWTs are base64url with the padding stripped; put it back before decoding.
    padded = payload + "=" * (-len(payload) % 4)
    try:
        return json.loads(base64.urlsafe_b64decode(padded.encode()).decode())
    except (ValueError, UnicodeDecodeError) as err:
        raise GoogleAuthError("Google returned an unreadable identity token.") from err
