"""
The tokenless session: what it buys, and — mostly — what it must not.

The app is usable before anyone pastes a token, which means there is now a
principal in the system that is authenticated in DRF's sense and yet has no
authority over any real workspace. Most of this file exists to pin the second
half of that sentence.
"""

import pytest
import responses as responses_lib
from rest_framework.test import APIClient

from apps.auth_workspace.models import WorkspaceSession
from apps.catalog.models import CatalogComponent
from apps.diagrams.models import Diagram
from tests.conftest import API_BASE, FAKE_TOKEN, WORKSPACE

pytestmark = pytest.mark.django_db


# --- Starting one -----------------------------------------------------------

def test_starting_an_anonymous_session_sets_the_cookie(client):
    response = client.post("/api/session/anonymous")
    assert response.status_code == 201
    # The same shape `GET /api/session` answers with, and `hasSession` in particular.
    # This used to reply without it, so the SPA read the session it had just been handed
    # as no session at all -- which hid the sign-in button and reported the state wrong.
    assert response.json() == {
        "hasSession": True,
        "account": None,
        "workspace": None,
        "connected": False,
        "anonymous": True,
        "auth": {"google": False},
    }

    cookie = response.cookies["sab_session"]
    assert cookie.value
    assert cookie["httponly"]
    assert cookie["samesite"] == "Lax"

    session = WorkspaceSession.objects.get()
    assert session.encrypted_token is None
    assert not session.has_token


def test_anonymous_sessions_do_not_share_a_scope(db):
    a = WorkspaceSession.start_anonymous()
    b = WorkspaceSession.start_anonymous()
    # A shared scope would put every anonymous visitor's diagrams in one pile that
    # they could all read, which is the failure this is guarding.
    assert a.anon_scope != b.anon_scope
    assert a.anon_scope and b.anon_scope
    # And the scope is no longer smuggled through workspace_id, which now means only
    # "a real Segment workspace".
    assert a.workspace_id == ""


def test_starting_again_reuses_the_session_you_already_have(anon_client, anon_session):
    """
    Idempotent, or a remount would strand the diagrams saved against the first
    scope behind a cookie that no longer exists.
    """
    response = anon_client.post("/api/session/anonymous")
    assert response.status_code == 200
    assert response.json()["anonymous"] is True
    assert WorkspaceSession.objects.count() == 1


def test_starting_anonymously_never_downgrades_a_connected_session(auth_client, session):
    response = auth_client.post("/api/session/anonymous")
    assert response.status_code == 200
    assert response.json()["connected"] is True
    assert WorkspaceSession.objects.get().pk == session.pk


def test_get_session_reports_the_anonymous_state(anon_client):
    assert anon_client.get("/api/session").json() == {
        # True even though both flags below are false: the SPA branches on this to
        # decide whether to mint a session, and "connected or anonymous" stopped being
        # the same question once an account could exist without a workspace.
        "hasSession": True,
        "account": None,
        "workspace": None,
        "connected": False,
        "anonymous": True,
        "auth": {"google": False},
    }


# --- What it must not reach -------------------------------------------------

@pytest.mark.parametrize(
    "path",
    [
        "/api/workspace/graph",
        "/api/workspace/sources",
        "/api/workspace/destinations",
        "/api/workspace/spaces",
        "/api/workspace/functions",
    ],
)
def test_anonymous_session_cannot_read_the_workspace(anon_client, path):
    """
    `HasWorkspaceSession` is the DRF default, so this covers endpoints nobody has
    written yet as much as these five. If it ever passes one through, the default
    has stopped meaning "a real token".
    """
    response = anon_client.get(path)
    assert response.status_code == 403
    # Not 401: that tells the SPA to re-bootstrap, which would discard the
    # anonymous cookie the visitor's unsaved work is scoped to.
    assert response.json()["error"]["code"] == "workspace_not_connected"


def test_anonymous_session_cannot_reveal_a_write_key(anon_client):
    response = anon_client.post("/api/workspace/sources/src_1/reveal-write-key")
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "workspace_not_connected"


def test_revealing_a_token_on_a_tokenless_session_raises(anon_session):
    """
    Belt and braces behind the permission. Nothing should reach this, so a loud
    failure is how a mis-set permission gets found instead of a decrypt error.
    """
    with pytest.raises(ValueError, match="no token"):
        anon_session.reveal_token()


# --- What it may reach ------------------------------------------------------

def test_catalog_is_readable_without_a_session(client, db):
    CatalogComponent.objects.create(
        slug="segment-js", name="Javascript", kind=CatalogComponent.SOURCE, categories=["Website"]
    )
    response = client.get("/api/catalog/sources")
    assert response.status_code == 200
    assert [item["slug"] for item in response.json()["items"]] == ["segment-js"]


def test_anonymous_session_can_save_and_read_its_own_diagrams(anon_client, anon_session):
    created = anon_client.post(
        "/api/diagrams",
        {"name": "Drawn before connecting", "graph": {"nodes": [], "edges": []}},
        format="json",
    )
    assert created.status_code == 201
    saved = Diagram.objects.get()
    # Owned by the scope, and about no workspace: nothing has been connected.
    assert saved.anon_scope == anon_session.anon_scope
    assert saved.workspace_id == ""
    assert saved.owner_id is None

    names = [item["name"] for item in anon_client.get("/api/diagrams").json()["items"]]
    assert names == ["Drawn before connecting"]


def test_one_anonymous_scope_cannot_read_another(anon_client, db):
    """
    An anonymous scope is a real scope, not a shared bucket: the isolation test that
    exists for two token-holders has to hold between two visitors too.
    """
    other = WorkspaceSession.start_anonymous()
    theirs = Diagram.objects.create(
        anon_scope=other.anon_scope, name="Theirs", graph={"nodes": []}
    )

    assert anon_client.get(f"/api/diagrams/{theirs.id}").status_code == 404
    assert anon_client.get("/api/diagrams").json()["items"] == []


def test_saving_a_diagram_still_needs_a_session(client):
    assert client.post("/api/diagrams", {"name": "X", "graph": {}}, format="json").status_code == 401


# --- Claiming ---------------------------------------------------------------

def test_connecting_claims_the_diagrams_drawn_anonymously(anon_client, anon_session, workspace_ok):
    drawn = Diagram.objects.create(
        anon_scope=anon_session.anon_scope, name="Drawn first", graph={"nodes": []}
    )

    response = anon_client.post(
        "/api/session", {"token": FAKE_TOKEN, "region": "us"}, format="json"
    )
    assert response.status_code == 201
    assert response.json()["claimed"] == 1

    drawn.refresh_from_db()
    # What connecting establishes is what the diagram is *about*. Who may see it is
    # unchanged -- still this scope, which the new session row carries forward -- because
    # pasting a credential says nothing about who someone is.
    assert drawn.workspace_id == WORKSPACE["id"]
    assert drawn.anon_scope == anon_session.anon_scope
    # The spent scope goes with it: its cookie is being overwritten by this very
    # response, so the row could never be reached again.
    assert not WorkspaceSession.objects.filter(pk=anon_session.pk).exists()


def test_connecting_claims_only_the_scope_you_hold(anon_client, anon_session, workspace_ok):
    stranger = WorkspaceSession.start_anonymous()
    theirs = Diagram.objects.create(
        anon_scope=stranger.anon_scope, name="Someone else's", graph={"nodes": []}
    )

    response = anon_client.post(
        "/api/session", {"token": FAKE_TOKEN, "region": "us"}, format="json"
    )
    assert response.json()["claimed"] == 0

    theirs.refresh_from_db()
    assert theirs.anon_scope == stranger.anon_scope
    assert theirs.workspace_id == ""
    assert WorkspaceSession.objects.filter(pk=stranger.pk).exists()


def test_connecting_with_no_prior_cookie_claims_nothing(client, workspace_ok):
    orphan = WorkspaceSession.start_anonymous()
    Diagram.objects.create(anon_scope=orphan.anon_scope, name="Orphan", graph={"nodes": []})

    response = client.post("/api/session", {"token": FAKE_TOKEN, "region": "us"}, format="json")
    assert response.json()["claimed"] == 0
    assert Diagram.objects.get().anon_scope == orphan.anon_scope


def test_a_rejected_token_leaves_the_anonymous_work_alone(anon_client, anon_session, mock_segment):
    """
    The claim runs inside the same transaction as the session it claims into, so a
    401 from Segment must not move anything.
    """
    mock_segment.add(responses_lib.GET, f"{API_BASE}/", json={}, status=401)
    drawn = Diagram.objects.create(
        anon_scope=anon_session.anon_scope, name="Drawn first", graph={"nodes": []}
    )

    assert anon_client.post(
        "/api/session", {"token": "sgp_bad_token_value_000", "region": "us"}, format="json"
    ).status_code == 401

    drawn.refresh_from_db()
    assert drawn.anon_scope == anon_session.anon_scope
    assert drawn.workspace_id == ""
    assert WorkspaceSession.objects.filter(pk=anon_session.pk).exists()


def test_reassign_workspace_refuses_a_no_op(db):
    """
    Guards against the shape of call that would rewrite every diagram in a scope
    for nothing: a missing id read as "" would otherwise match nothing, but a
    from == to would churn rows on every reconnect.
    """
    Diagram.objects.create(workspace_id="ws_a", name="A", graph={})
    assert Diagram.objects.reassign_workspace(from_id="ws_a", to_id="ws_a") == 0
    assert Diagram.objects.reassign_workspace(from_id="", to_id="ws_b") == 0
    assert Diagram.objects.get().workspace_id == "ws_a"


def test_claiming_survives_a_csrf_enforced_client(anon_session, workspace_ok):
    """The claim is on the POST that plants a real cookie, so CSRF applies to it."""
    client = APIClient(enforce_csrf_checks=True)
    client.cookies["sab_session"] = str(anon_session.id)
    Diagram.objects.create(
        anon_scope=anon_session.anon_scope, name="Drawn first", graph={"nodes": []}
    )

    token = client.get("/api/session").cookies["csrftoken"].value
    response = client.post(
        "/api/session",
        {"token": FAKE_TOKEN, "region": "us"},
        format="json",
        HTTP_X_CSRFTOKEN=token,
    )
    assert response.status_code == 201
    assert response.json()["claimed"] == 1
