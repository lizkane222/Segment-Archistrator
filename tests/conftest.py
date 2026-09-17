"""Shared fixtures. Nothing here ever touches the real Segment API, or Google."""

import base64
import json
import time

import pytest
import responses as responses_lib
from rest_framework.test import APIClient

from apps.accounts.models import Account
from apps.auth_workspace.models import WorkspaceSession

FAKE_TOKEN = "sgp_test_tokenvalue_0123456789"
WORKSPACE = {"id": "ws_test123", "name": "Acme Corp", "slug": "acme-corp"}
API_BASE = "https://api.segmentapis.com"

GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
GOOGLE_CLIENT_ID = "123456.apps.googleusercontent.com"
GOOGLE_SUB = "107691503500061507151"


@pytest.fixture
def mock_segment():
    """Intercept all outbound HTTP. A test that forgets to stub gets an error."""
    with responses_lib.RequestsMock(assert_all_requests_are_fired=False) as rsps:
        yield rsps


@pytest.fixture
def workspace_ok(mock_segment):
    """`GET /` succeeds, returning WORKSPACE."""
    mock_segment.add(
        responses_lib.GET,
        f"{API_BASE}/",
        json={"data": {"workspace": WORKSPACE}},
        status=200,
    )
    return mock_segment


@pytest.fixture
def session(db):
    return WorkspaceSession.start(token=FAKE_TOKEN, workspace=WORKSPACE, region="us")


@pytest.fixture
def anon_session(db):
    return WorkspaceSession.start_anonymous()


@pytest.fixture
def client():
    return APIClient()


@pytest.fixture
def anon_client(anon_session):
    """A client carrying a tokenless session: a save scope and nothing more."""
    client = APIClient()
    client.cookies["sab_session"] = str(anon_session.id)
    return client


@pytest.fixture
def auth_client(session):
    """
    A client carrying a valid session cookie.

    enforce_csrf_checks stays False here: CSRF has its own dedicated test, and
    leaving it on would force every mutation test to juggle tokens.
    """
    client = APIClient()
    client.cookies["sab_session"] = str(session.id)
    return client


# --- Accounts and Google ----------------------------------------------------


@pytest.fixture
def account(db):
    return Account.objects.create(
        email="liz@example.com", google_sub=GOOGLE_SUB, name="Liz Kane"
    )


@pytest.fixture
def account_session(account):
    """A signed-in session with no workspace connected -- the state `hasSession` exists for."""
    session = WorkspaceSession.start_for_account(account)
    return session


@pytest.fixture
def account_client(account_session):
    """Signed in, planted the same way every other client here is. There is no login form."""
    client = APIClient()
    client.cookies["sab_session"] = str(account_session.id)
    return client


@pytest.fixture
def twilio_account(db):
    """
    A signed-in Twilion. The GraphQL credential -- somebody's whole login session --
    is gated to `@twilio.com` accounts server-side, so any test exercising that flow
    needs an account with this domain rather than `account`'s `example.com`.
    """
    return Account.objects.create(
        email="sol@twilio.com", google_sub="107691503500061507999", name="Sol Twilio"
    )


@pytest.fixture
def twilio_account_session(twilio_account):
    return WorkspaceSession.start_for_account(twilio_account)


@pytest.fixture
def twilio_client(twilio_account_session):
    """Signed in as a Twilion, so `credential=graphql` connects are not refused at the gate."""
    client = APIClient()
    client.cookies["sab_session"] = str(twilio_account_session.id)
    return client


@pytest.fixture
def google_configured(settings):
    settings.GOOGLE_OAUTH_CLIENT_ID = GOOGLE_CLIENT_ID
    settings.GOOGLE_OAUTH_CLIENT_SECRET = "test-client-secret"
    settings.GOOGLE_OAUTH_REDIRECT_URI = "http://testserver/api/auth/google/callback"
    settings.ALLOWED_EMAIL_DOMAINS = ["example.com"]
    return settings


def fake_id_token(**overrides):
    """
    A Google ID token whose signature is deliberate nonsense.

    That is the test, not a shortcut. This app reads the token out of the body of its
    own HTTPS POST to Google, authenticated with its own client secret, so TLS already
    establishes who sent it and the signature adds nothing -- see the docstring in
    apps/accounts/google.py. If this fixture ever stops working, either signature
    verification was added (which needs a JWKS fetch and a real key) or something
    started accepting an ID token from a client. Both deserve to fail loudly.
    """
    claims = {
        "iss": "https://accounts.google.com",
        "aud": GOOGLE_CLIENT_ID,
        "sub": GOOGLE_SUB,
        "email": "liz@example.com",
        "email_verified": True,
        "name": "Liz Kane",
        "picture": "https://example.com/avatar.png",
        "exp": int(time.time()) + 3600,
    }
    claims.update(overrides)

    def segment(payload):
        return base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b"=").decode()

    return f"{segment({'alg': 'RS256'})}.{segment(claims)}.not-a-real-signature"


@pytest.fixture
def google_ok(mock_segment, google_configured):
    """
    Google's token endpoint answers with a usable identity.

    Stubbed through `mock_segment` rather than a second interceptor: it already
    intercepts *all* outbound HTTP, so a test that reaches Google without meaning to
    still errors.
    """
    mock_segment.add(
        responses_lib.POST,
        GOOGLE_TOKEN_URL,
        json={"id_token": fake_id_token(), "token_type": "Bearer", "expires_in": 3599},
        status=200,
    )
    return mock_segment
