"""
Tab groups: one browser, one cookie, several workspaces at once.

Which workspace a request is about is chosen per request by `X-Workspace-Id`, from among the
*account's own* remembered connections. What is asserted:

  - the header selects a remembered connection and nothing else -- another account's workspace,
    or a made-up one, is refused rather than quietly answered with the session's own;
  - `none` is a tab about no workspace, and sees no workspace data and no shared diagrams;
  - a scoped request never writes the other workspace onto the shared session row;
  - disconnecting a workspace keeps the person signed in.
"""

import pytest
from rest_framework.test import APIClient

from apps.accounts.models import Account
from apps.auth_workspace.models import RememberedConnection, WorkspaceSession
from apps.diagrams.models import Diagram
from tests.conftest import FAKE_TOKEN, WORKSPACE

pytestmark = pytest.mark.django_db

OTHER = {"id": "ws_other456", "name": "Globex", "slug": "globex"}
OTHER_TOKEN = "sgp_test_other_token_9876543210"


@pytest.fixture
def liz(db):
    return Account.objects.create(email="liz@twilio.com", google_sub="sub-liz")


@pytest.fixture
def two_workspaces(liz):
    """One signed-in browser holding Acme as its session and Globex as a remembered extra."""
    acme = WorkspaceSession.start(
        token=FAKE_TOKEN, workspace=WORKSPACE, account=liz, anon_scope="anon:liz"
    )
    RememberedConnection.remember(acme)
    globex = WorkspaceSession.start(
        token=OTHER_TOKEN, workspace=OTHER, account=liz, anon_scope="anon:liz-2"
    )
    RememberedConnection.remember(globex)
    globex.delete()
    client = APIClient()
    client.cookies["sab_session"] = str(acme.id)
    return client, acme


def scoped(client, workspace_id):
    return {"HTTP_X_WORKSPACE_ID": workspace_id}


def test_the_session_payload_lists_every_connection_without_a_token(two_workspaces):
    client, _ = two_workspaces
    payload = client.get("/api/session").json()
    assert {c["id"] for c in payload["connections"]} == {WORKSPACE["id"], OTHER["id"]}
    text = str(payload)
    assert FAKE_TOKEN not in text and OTHER_TOKEN not in text
    assert "encrypted" not in text and "fingerprint" not in text


def test_a_request_can_act_as_the_other_remembered_workspace(two_workspaces):
    client, acme = two_workspaces
    created = client.post(
        "/api/diagrams", {"name": "g", "graph": {"nodes": [], "edges": []}}, format="json",
        **scoped(client, OTHER["id"]),
    )
    assert created.status_code == 201
    assert created.json()["workspace_id"] == OTHER["id"]


def test_a_request_with_no_header_uses_the_sessions_own_workspace(two_workspaces):
    client, _ = two_workspaces
    created = client.post("/api/diagrams", {"name": "g", "graph": {"nodes": [], "edges": []}}, format="json")
    assert created.json()["workspace_id"] == WORKSPACE["id"]


def test_the_real_session_row_is_never_changed_by_a_scoped_request(two_workspaces):
    client, acme = two_workspaces
    client.get("/api/diagrams", **scoped(client, OTHER["id"]))
    client.post("/api/diagrams", {"name": "g", "graph": {"nodes": [], "edges": []}}, format="json", **scoped(client, OTHER["id"]))
    acme.refresh_from_db()
    assert acme.workspace_id == WORKSPACE["id"]
    assert acme.token_fingerprint


def test_a_workspace_the_account_never_connected_is_refused(two_workspaces):
    client, _ = two_workspaces
    response = client.get("/api/diagrams", **scoped(client, "ws_never_connected"))
    assert response.status_code == 403


def test_another_accounts_workspace_is_refused(two_workspaces):
    client, _ = two_workspaces
    mallory = Account.objects.create(email="mallory@twilio.com", google_sub="sub-mal")
    theirs = WorkspaceSession.start(
        token="sgp_mallory_token_0000000000", workspace={"id": "ws_mallory", "name": "M", "slug": "m"},
        account=mallory, anon_scope="anon:mal",
    )
    RememberedConnection.remember(theirs)
    response = client.get("/api/diagrams", **scoped(client, "ws_mallory"))
    assert response.status_code == 403


def test_none_is_a_tab_about_no_workspace(two_workspaces):
    client, _ = two_workspaces
    created = client.post(
        "/api/diagrams", {"name": "blank", "graph": {"nodes": [], "edges": []}}, format="json",
        **scoped(client, "none"),
    )
    assert created.json()["workspace_id"] == ""


def test_none_cannot_read_workspace_data(two_workspaces):
    client, _ = two_workspaces
    assert client.get("/api/workspace/sources", **scoped(client, "none")).status_code in (401, 403)


def test_a_diagram_shared_with_one_workspace_is_invisible_from_the_other_group(two_workspaces, liz):
    client, _ = two_workspaces
    teammate = Account.objects.create(email="t@twilio.com", google_sub="sub-t")
    Diagram.objects.create(
        name="shared with acme", owner=teammate, workspace_id=WORKSPACE["id"], shared_with_workspace=True
    )
    in_acme = client.get("/api/diagrams", **scoped(client, WORKSPACE["id"])).json()["items"]
    in_globex = client.get("/api/diagrams", **scoped(client, OTHER["id"])).json()["items"]
    assert [d["name"] for d in in_acme] == ["shared with acme"]
    assert in_globex == []


def test_session_routes_are_not_scoped(two_workspaces):
    """`/api/session` describes the real row, whichever tab asked."""
    client, acme = two_workspaces
    payload = client.get("/api/session", **scoped(client, OTHER["id"])).json()
    assert payload["workspace"]["id"] == WORKSPACE["id"]


def test_a_scoped_session_view_cannot_be_saved_or_deleted(two_workspaces):
    _, acme = two_workspaces
    view = acme.scoped_to(None)
    with pytest.raises(RuntimeError):
        view.save()
    with pytest.raises(RuntimeError):
        view.delete()


def test_disconnecting_keeps_the_person_signed_in(two_workspaces, liz):
    client, acme = two_workspaces
    response = client.delete("/api/session")
    assert response.status_code == 204
    acme.refresh_from_db()
    assert acme.account_id == liz.id
    assert not acme.has_token
    assert not RememberedConnection.objects.filter(account=liz, workspace_id=WORKSPACE["id"]).exists()
    assert RememberedConnection.objects.filter(account=liz, workspace_id=OTHER["id"]).exists()
    assert client.get("/api/session").json()["hasSession"] is True


def test_forgetting_one_connection_leaves_the_others(two_workspaces, liz):
    client, acme = two_workspaces
    assert client.delete(f"/api/connections/{OTHER['id']}").status_code == 204
    assert not RememberedConnection.objects.filter(account=liz, workspace_id=OTHER["id"]).exists()
    acme.refresh_from_db()
    assert acme.has_token


def test_forgetting_the_connection_this_session_holds_lets_go_of_it(two_workspaces, liz):
    client, acme = two_workspaces
    client.delete(f"/api/connections/{WORKSPACE['id']}")
    acme.refresh_from_db()
    assert not acme.has_token
    assert acme.account_id == liz.id


def test_one_account_cannot_forget_anothers_connection(two_workspaces):
    client, _ = two_workspaces
    mallory = Account.objects.create(email="mallory@twilio.com", google_sub="sub-mal")
    theirs = WorkspaceSession.start(
        token="sgp_mallory_token_0000000000", workspace={"id": "ws_mallory", "name": "M", "slug": "m"},
        account=mallory, anon_scope="anon:mal",
    )
    RememberedConnection.remember(theirs)
    client.delete("/api/connections/ws_mallory")
    assert RememberedConnection.objects.filter(account=mallory).exists()
