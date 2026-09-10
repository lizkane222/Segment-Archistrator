"""Shared fixtures. Nothing here ever touches the real Segment API."""

import pytest
import responses as responses_lib
from rest_framework.test import APIClient

from apps.auth_workspace.models import WorkspaceSession

FAKE_TOKEN = "sgp_test_tokenvalue_0123456789"
WORKSPACE = {"id": "ws_test123", "name": "Acme Corp", "slug": "acme-corp"}
API_BASE = "https://api.segmentapis.com"


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
