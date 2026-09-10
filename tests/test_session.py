"""
The login flow, and the guarantees it is supposed to provide.

The brief's requirement was that sensitive data be "securely stored and
obfuscated". These tests are the operational reading of that: the token must not
appear in any response, must not be stored in cleartext, and possession of a
session for one workspace must grant nothing in another.
"""

import json

import pytest
import responses

from apps.auth_workspace.models import WorkspaceSession
from tests.conftest import API_BASE, FAKE_TOKEN, WORKSPACE

pytestmark = pytest.mark.django_db


def test_get_session_with_no_cookie(client):
    # "anonymous" is now a state of its own -- a cookie for a tokenless scope --
    # so no-cookie has to report False for it, not merely a null workspace.
    response = client.get("/api/session")
    assert response.status_code == 200
    assert response.json() == {"workspace": None, "connected": False, "anonymous": False}


def test_get_session_plants_the_csrf_cookie(client):
    """The SPA relies on this: boot with GET, then POST with the token it set."""
    response = client.get("/api/session")
    assert "csrftoken" in response.cookies


def test_post_valid_token_creates_a_session(client, workspace_ok):
    response = client.post(
        "/api/session", {"token": FAKE_TOKEN, "region": "us"}, format="json"
    )
    assert response.status_code == 201
    assert response.json()["workspace"]["slug"] == "acme-corp"

    session = WorkspaceSession.objects.get()
    assert session.workspace_id == WORKSPACE["id"]
    assert "sab_session" in response.cookies
    assert response.cookies["sab_session"].value == str(session.id)


def test_session_cookie_is_httponly_and_lax(client, workspace_ok):
    response = client.post(
        "/api/session", {"token": FAKE_TOKEN, "region": "us"}, format="json"
    )
    cookie = response.cookies["sab_session"]
    # httpOnly means script cannot read it; Lax is what makes the same-origin
    # deployment enough to stop cross-site use.
    assert cookie["httponly"]
    assert cookie["samesite"] == "Lax"


def test_token_never_appears_in_the_response(client, workspace_ok):
    response = client.post(
        "/api/session", {"token": FAKE_TOKEN, "region": "us"}, format="json"
    )
    body = json.dumps(response.json())
    assert FAKE_TOKEN not in body
    # Not even a prefix long enough to be useful.
    assert FAKE_TOKEN[:12] not in body
    assert FAKE_TOKEN not in str(response.cookies)


def test_token_is_not_stored_in_cleartext(client, workspace_ok):
    client.post("/api/session", {"token": FAKE_TOKEN, "region": "us"}, format="json")
    session = WorkspaceSession.objects.get()
    stored = bytes(session.encrypted_token)
    assert FAKE_TOKEN.encode() not in stored
    # But it must still be recoverable for the API proxy to work at all.
    assert session.reveal_token() == FAKE_TOKEN


def test_bad_token_is_rejected_and_persists_nothing(client, mock_segment):
    mock_segment.add(
        responses.GET,
        f"{API_BASE}/",
        json={"errors": [{"message": "invalid credentials"}]},
        status=401,
    )
    response = client.post(
        "/api/session", {"token": "sgp_wrong", "region": "us"}, format="json"
    )
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "invalid_token"
    assert WorkspaceSession.objects.count() == 0


def test_bad_token_fails_immediately_without_retrying(client, mock_segment):
    """
    A 401 must not be retried.

    The reference script this client was modelled on retried any status >= 400
    twelve times with exponential backoff, which would have made a mistyped token
    hang for hours. Exactly one request should reach Segment.
    """
    mock_segment.add(responses.GET, f"{API_BASE}/", json={}, status=401)
    client.post("/api/session", {"token": "sgp_wrong", "region": "us"}, format="json")
    assert len(mock_segment.calls) == 1


def test_token_accepted_with_bearer_prefix_and_quotes(client, workspace_ok):
    """People paste from curl commands and from JSON config. Both should work."""
    response = client.post(
        "/api/session", {"token": f'Bearer "{FAKE_TOKEN}"', "region": "us"}, format="json"
    )
    assert response.status_code == 201
    assert WorkspaceSession.objects.get().reveal_token() == FAKE_TOKEN


def test_repasting_the_same_token_reuses_one_row(client, workspace_ok):
    workspace_ok.add(
        responses.GET, f"{API_BASE}/", json={"data": {"workspace": WORKSPACE}}, status=200
    )
    for _ in range(2):
        client.post("/api/session", {"token": FAKE_TOKEN, "region": "us"}, format="json")
    assert WorkspaceSession.objects.count() == 1


def test_delete_session_removes_the_stored_token(auth_client, session):
    response = auth_client.delete("/api/session")
    assert response.status_code == 204
    # The row is gone, not just the cookie -- otherwise the encrypted token would
    # linger with nothing able to reach it.
    assert WorkspaceSession.objects.count() == 0


def test_authenticated_get_returns_the_workspace_only(auth_client):
    payload = auth_client.get("/api/session").json()["workspace"]
    assert payload == {
        "id": WORKSPACE["id"],
        "name": WORKSPACE["name"],
        "slug": WORKSPACE["slug"],
        "region": "us",
        # Which of the two ways in this session used, and whether that credential can reach
        # the Public API. The UI needs the second to explain why "Load workspace" is
        # unavailable rather than letting the user discover it from a failed request.
        "credential": "public_api",
        "canReadWorkspace": True,
    }
    # The assertion this test exists for. `credential` names the *kind* of credential and
    # `canReadWorkspace` is a boolean, so neither is the token -- but the check is written
    # against the whole serialized payload precisely so that adding a field cannot quietly
    # add one that is.
    assert "sgp_" not in json.dumps(payload)
    for key in payload:
        assert "token" not in key.lower()


def test_expired_session_is_rejected_and_deleted(auth_client, session, settings):
    from datetime import timedelta

    from django.utils import timezone

    WorkspaceSession.objects.filter(pk=session.pk).update(
        last_seen_at=timezone.now()
        - timedelta(hours=settings.WORKSPACE_SESSION_IDLE_HOURS + 1)
    )
    assert auth_client.get("/api/session").json() == {
        "workspace": None,
        "connected": False,
        "anonymous": False,
    }
    assert WorkspaceSession.objects.count() == 0


def test_unknown_cookie_is_not_authenticated(client):
    client.cookies["sab_session"] = "00000000-0000-0000-0000-000000000000"
    assert client.get("/api/session").json() == {
        "workspace": None,
        "connected": False,
        "anonymous": False,
    }


def test_malformed_cookie_does_not_error(client):
    """A garbage cookie must read as unauthenticated, not raise."""
    client.cookies["sab_session"] = "not-a-uuid"
    assert client.get("/api/session").status_code == 200


def test_protected_endpoint_requires_a_session(client):
    """
    401, not 403. The SPA routes on this: 401 means "go paste a token", 403 means
    "you are authenticated and still not allowed", which is a bug worth showing.
    """
    response = client.get("/api/workspace/sources")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "not_authenticated"
