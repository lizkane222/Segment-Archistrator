"""
A signed-in account's workspace connections outlive the session that held them.

The session row is the only thing that held a credential, and it dies on idle expiry,
on log out and on every sign-in rotation -- so coming back the next day meant coming
back disconnected, and every diagram shared with that workspace out of reach.

What is asserted here:

  - connecting while signed in remembers the credential for the account, encrypted;
  - signing in again restores it, and signing in as someone else never does;
  - a saved diagram records the workspace its bound components came from, and says
    whether this account can resume it;
  - `POST /api/session/resume` reconnects only from the caller's own account;
  - Disconnect forgets it, because that is the control that says "stop holding this".
"""

import pytest
from rest_framework.test import APIClient

from apps.accounts.models import Account
from apps.auth_workspace.models import RememberedConnection, WorkspaceSession
from apps.diagrams.models import Diagram
from tests.conftest import FAKE_TOKEN, WORKSPACE

from .test_oauth import CALLBACK, begin

pytestmark = pytest.mark.django_db

OTHER_WORKSPACE = {"id": "ws_other456", "name": "Globex", "slug": "globex"}
RESUME = "/api/session/resume"

BOUND_GRAPH = {
    "nodes": [
        {
            "id": "src:1",
            "type": "source",
            "data": {"kind": "source", "name": "Website", "bound": True, "segmentId": "src_abc"},
        }
    ],
    "edges": [],
}


def client_for(session):
    client = APIClient()
    client.cookies["sab_session"] = str(session.id)
    return client


def connected(account, workspace=WORKSPACE, token=FAKE_TOKEN):
    """A signed-in session holding a credential, remembered the way connecting does."""
    session = WorkspaceSession.start(token=token, workspace=workspace, region="us", account=account)
    RememberedConnection.remember(session)
    return session


# --- remembering ------------------------------------------------------------


def test_connecting_while_signed_in_remembers_the_connection(account_client, account, workspace_ok):
    response = account_client.post("/api/session", {"token": FAKE_TOKEN, "region": "us"}, format="json")
    assert response.status_code == 201

    remembered = RememberedConnection.objects.get(account=account)
    assert remembered.workspace_id == WORKSPACE["id"]
    assert remembered.workspace_slug == WORKSPACE["slug"]
    # Encrypted at rest, exactly like the session's copy.
    assert FAKE_TOKEN.encode() not in bytes(remembered.encrypted_token)


def test_connecting_anonymously_remembers_nothing(client, workspace_ok):
    client.post("/api/session", {"token": FAKE_TOKEN, "region": "us"}, format="json")
    assert not RememberedConnection.objects.exists()


def test_one_row_per_workspace_however_often_it_is_connected(account):
    connected(account)
    connected(account)
    assert RememberedConnection.objects.filter(account=account).count() == 1


# --- coming back ------------------------------------------------------------


def test_signing_in_the_next_day_comes_back_connected(account, google_ok):
    """The reported bug: yesterday's session lapsed, today's sign-in starts from nothing."""
    yesterday = connected(account)
    yesterday.delete()  # idle expiry, as the authentication class does it

    client = APIClient()
    response = client.get(CALLBACK, {"state": begin(client), "code": "code-1"})
    session = WorkspaceSession.objects.get(pk=response.cookies["sab_session"].value)

    assert session.account_id == account.id
    assert session.has_token
    assert session.workspace_id == WORKSPACE["id"]
    assert session.reveal_token() == FAKE_TOKEN

    payload = client.get("/api/session").json()
    assert payload["connected"] is True
    assert payload["workspace"]["slug"] == WORKSPACE["slug"]


def test_sign_in_restores_the_most_recently_used_workspace(account, google_ok):
    connected(account, OTHER_WORKSPACE, token="sgp_globex_token_1111111111").delete()
    connected(account).delete()

    client = APIClient()
    response = client.get(CALLBACK, {"state": begin(client), "code": "code-1"})
    session = WorkspaceSession.objects.get(pk=response.cookies["sab_session"].value)
    assert session.workspace_id == WORKSPACE["id"]


def test_a_lapsed_session_holding_the_same_token_does_not_block_the_restore(account, google_ok):
    """
    (workspace, token) is unique among rows holding one. A stale-but-undeleted session of
    the same person's is exactly where the duplicate would be.
    """
    connected(account)  # left in place, not deleted

    client = APIClient()
    response = client.get(CALLBACK, {"state": begin(client), "code": "code-1"})
    session = WorkspaceSession.objects.get(pk=response.cookies["sab_session"].value)
    assert session.has_token


def test_another_accounts_remembered_connection_is_never_restored(account, google_ok):
    other = Account.objects.create(email="sam@example.com", google_sub="sam-sub")
    connected(other).delete()

    client = APIClient()
    response = client.get(CALLBACK, {"state": begin(client), "code": "code-1"})
    session = WorkspaceSession.objects.get(pk=response.cookies["sab_session"].value)
    assert not session.has_token


# --- resuming from a diagram ------------------------------------------------


def test_resume_reconnects_to_the_named_workspace(account, account_client):
    connected(account, OTHER_WORKSPACE, token="sgp_globex_token_1111111111").delete()
    connected(account).delete()

    response = account_client.post(RESUME, {"workspace_id": OTHER_WORKSPACE["id"]}, format="json")
    assert response.status_code == 200
    assert response.json()["workspace"]["slug"] == OTHER_WORKSPACE["slug"]


def test_resume_cannot_reach_a_workspace_this_account_never_connected(account_client):
    other = Account.objects.create(email="sam@example.com", google_sub="sam-sub")
    connected(other).delete()

    response = account_client.post(RESUME, {"workspace_id": WORKSPACE["id"]}, format="json")
    assert response.status_code == 404


def test_resume_needs_an_account(anon_client):
    response = anon_client.post(RESUME, {"workspace_id": WORKSPACE["id"]}, format="json")
    assert response.status_code == 403


# --- forgetting -------------------------------------------------------------


def test_disconnect_forgets_the_remembered_connection(account):
    session = connected(account)
    response = client_for(session).delete("/api/session")
    assert response.status_code == 204
    assert not RememberedConnection.objects.filter(account=account).exists()


# --- diagrams ---------------------------------------------------------------


def test_a_diagram_bound_after_creation_records_its_workspace(account, account_session):
    """Created before connecting, bound after: it must still say what it is about."""
    diagram = Diagram.objects.create(owner=account, name="Drawn first", graph={"nodes": []})
    session = connected(account)

    response = client_for(session).patch(
        f"/api/diagrams/{diagram.id}", {"graph": BOUND_GRAPH}, format="json"
    )
    assert response.status_code == 200
    diagram.refresh_from_db()
    assert diagram.workspace_id == WORKSPACE["id"]


def test_an_unbound_diagram_is_not_stamped_with_whatever_happens_to_be_connected(account):
    diagram = Diagram.objects.create(owner=account, name="Sketch", graph={"nodes": []})
    session = connected(account)
    client_for(session).patch(
        f"/api/diagrams/{diagram.id}", {"graph": {"nodes": [], "edges": []}}, format="json"
    )
    diagram.refresh_from_db()
    assert diagram.workspace_id == ""


def test_a_reopened_diagram_says_its_workspace_can_be_resumed(account, account_client):
    connected(account).delete()
    diagram = Diagram.objects.create(
        owner=account, name="Saved yesterday", graph=BOUND_GRAPH, workspace_id=WORKSPACE["id"]
    )

    body = account_client.get(f"/api/diagrams/{diagram.id}").json()
    assert body["workspace"] == {
        "id": WORKSPACE["id"],
        "name": WORKSPACE["name"],
        "slug": WORKSPACE["slug"],
        "region": "us",
        "connected": False,
        "remembered": True,
    }


def test_a_diagram_about_no_workspace_has_none(account, account_client):
    diagram = Diagram.objects.create(owner=account, name="Blank", graph={"nodes": []})
    assert account_client.get(f"/api/diagrams/{diagram.id}").json()["workspace"] is None
