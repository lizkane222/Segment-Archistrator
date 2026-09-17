"""
CSRF and cross-workspace isolation -- the two ways a cookie-based auth model
usually leaks.
"""

import pytest
from rest_framework.test import APIClient

from apps.auth_workspace.models import WorkspaceSession
from apps.diagrams.models import Diagram
from tests.conftest import FAKE_TOKEN, WORKSPACE

pytestmark = pytest.mark.django_db


def test_mutation_without_a_csrf_token_is_rejected(session):
    """
    DRF marks every APIView csrf_exempt and expects the authentication class to
    re-enforce CSRF for cookie schemes. If this test ever passes a mutation
    through, the session cookie has become usable cross-site.
    """
    client = APIClient(enforce_csrf_checks=True)
    client.cookies["sab_session"] = str(session.id)

    response = client.post("/api/diagrams", {"name": "X", "graph": {}}, format="json")
    assert response.status_code == 403
    assert "CSRF" in str(response.data).upper()
    assert Diagram.objects.count() == 0


def test_mutation_with_a_csrf_token_succeeds(session, client):
    csrf_client = APIClient(enforce_csrf_checks=True)
    csrf_client.cookies["sab_session"] = str(session.id)

    token = csrf_client.get("/api/session").cookies["csrftoken"].value
    response = csrf_client.post(
        "/api/diagrams",
        {"name": "X", "graph": {"nodes": [], "edges": []}},
        format="json",
        HTTP_X_CSRFTOKEN=token,
    )
    assert response.status_code == 201


def test_safe_methods_do_not_require_csrf(session):
    client = APIClient(enforce_csrf_checks=True)
    client.cookies["sab_session"] = str(session.id)
    assert client.get("/api/diagrams").status_code == 200


def test_diagram_from_another_workspace_is_not_readable(auth_client, db):
    """
    The whole authorization model. A diagram id is a UUID, but guessability is
    not the defence -- the workspace scope is.
    """
    other = Diagram.objects.create(
        workspace_id="ws_someone_else", name="Their architecture", graph={"nodes": []}
    )

    assert auth_client.get(f"/api/diagrams/{other.id}").status_code == 404
    assert auth_client.patch(
        f"/api/diagrams/{other.id}", {"name": "hijacked"}, format="json"
    ).status_code == 404
    assert auth_client.delete(f"/api/diagrams/{other.id}").status_code == 404

    other.refresh_from_db()
    assert other.name == "Their architecture"


def test_diagram_list_is_scoped_to_the_session_workspace(auth_client):
    """
    A shared diagram is visible to a credential-holder for its workspace, and one from
    another workspace is not.

    `shared_with_workspace=True` is what these rows need now, and it is not a weakening
    of the test -- it is the same rule said explicitly. Workspace-wide visibility used to
    be the *only* rule, so a bare `workspace_id` implied it; now it has to be asked for,
    and a row that does not ask is private to its owner.
    """
    Diagram.objects.create(
        workspace_id=WORKSPACE["id"], shared_with_workspace=True, name="Mine", graph={}
    )
    Diagram.objects.create(
        workspace_id="ws_other", shared_with_workspace=True, name="Theirs", graph={}
    )

    names = [item["name"] for item in auth_client.get("/api/diagrams").json()["items"]]
    assert names == ["Mine"]


def test_an_unshared_diagram_is_invisible_even_within_the_same_workspace(auth_client, db):
    """
    The new default, and the point of the ownership split: holding a credential for a
    workspace no longer means reading everything anyone drew about it.
    """
    Diagram.objects.create(workspace_id=WORKSPACE["id"], name="Somebody's private draft", graph={})
    assert auth_client.get("/api/diagrams").json()["items"] == []


def test_workspace_id_in_the_request_body_is_ignored(auth_client):
    """A writable workspace_id would let any valid token write into any workspace."""
    response = auth_client.post(
        "/api/diagrams",
        {"name": "Injected", "graph": {}, "workspace_id": "ws_victim"},
        format="json",
    )
    assert response.status_code == 201
    assert Diagram.objects.get().workspace_id == WORKSPACE["id"]


def test_two_workspaces_with_the_same_token_are_separate_rows(db):
    """Same token, different workspace ids -- the unique constraint is on the pair."""
    a = WorkspaceSession.start(token=FAKE_TOKEN, workspace=WORKSPACE, region="us")
    b = WorkspaceSession.start(
        token=FAKE_TOKEN,
        workspace={"id": "ws_two", "name": "Other", "slug": "other"},
        region="us",
    )
    assert a.pk != b.pk
    assert WorkspaceSession.objects.count() == 2


def test_topology_is_readable_without_a_session(client):
    """The rule table holds no customer data, and the SPA needs it before login."""
    response = client.get("/api/meta/topology")
    assert response.status_code == 200
    assert "connections" in response.json()["kindsByZone"]
