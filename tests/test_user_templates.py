"""
Saving a diagram as a template, and who may see it afterwards.

  - a template with no workspace data in it is generic: any workspace may start from it;
  - one that still carries a workspace's ids or links is locked to that workspace, and the
    server decides that from the graph -- a client cannot call such a template generic;
  - private unless shared; shared still means "only people holding that workspace" when locked;
  - only the author deletes one, and a built-in cannot be deleted at all.
"""

import pytest
from rest_framework.test import APIClient

from apps.accounts.models import Account
from apps.auth_workspace.models import RememberedConnection, WorkspaceSession
from apps.diagrams.models import Template, carries_workspace_identity
from tests.conftest import FAKE_TOKEN, WORKSPACE

pytestmark = pytest.mark.django_db

OTHER = {"id": "ws_other456", "name": "Globex", "slug": "globex"}

GENERIC = {
    "nodes": [{"id": "a", "kind": "source", "data": {"kind": "source", "name": "Source", "bound": False}}],
    "edges": [],
}
OWNED = {
    "nodes": [
        {
            "id": "a",
            "kind": "source",
            "data": {"kind": "source", "name": "Acme web", "bound": True, "segmentId": "src_123"},
        }
    ],
    "edges": [],
}


def signed_in(email, sub, workspace=None, token=FAKE_TOKEN):
    account = Account.objects.create(email=email, google_sub=sub)
    session = WorkspaceSession.start(
        token=token, workspace=workspace or WORKSPACE, account=account, anon_scope=f"anon:{sub}"
    )
    RememberedConnection.remember(session)
    client = APIClient()
    client.cookies["sab_session"] = str(session.id)
    return client, account


def make(client, graph, **extra):
    return client.post("/api/templates", {"name": "T", "graph": graph, **extra}, format="json")


def names(client):
    return {t["key"] for t in client.get("/api/templates").json()["items"]}


def test_a_generic_diagram_becomes_a_generic_template():
    client, _ = signed_in("a@twilio.com", "a")
    response = make(client, GENERIC)
    assert response.status_code == 201
    body = response.json()
    assert body["locked_workspace_id"] == ""
    assert body["owner"] == "me"
    assert body["is_builtin"] is False
    assert body["key"].startswith("u-")


def test_a_diagram_still_carrying_workspace_data_is_locked_to_that_workspace():
    client, _ = signed_in("a@twilio.com", "a")
    assert make(client, OWNED).json()["locked_workspace_id"] == WORKSPACE["id"]


@pytest.mark.parametrize(
    "key",
    [
        "segmentId",
        "sourceId",
        "destinationId",
        "spaceId",
        "workspaceUrl",
        "previewWebhookUrl",
        "writeKeyMasked",
        "writeKeyLast4",
    ],
)
def test_any_one_identity_field_is_enough_to_lock_it(key):
    graph = {"nodes": [{"id": "a", "kind": "source", "data": {"kind": "source", key: "x"}}], "edges": []}
    assert carries_workspace_identity(graph)
    client, _ = signed_in("a@twilio.com", "a")
    assert make(client, graph).json()["locked_workspace_id"] == WORKSPACE["id"]


def test_the_lock_comes_from_the_graph_not_the_request():
    client, _ = signed_in("a@twilio.com", "a")
    response = make(client, OWNED, locked_workspace_id="", shared_with_company=True)
    assert response.json()["locked_workspace_id"] == WORKSPACE["id"]


def test_workspace_data_cannot_be_saved_from_a_tab_about_no_workspace():
    client, _ = signed_in("a@twilio.com", "a")
    response = client.post(
        "/api/templates", {"name": "T", "graph": OWNED}, format="json", HTTP_X_WORKSPACE_ID="none"
    )
    assert response.status_code == 400


def test_a_template_is_private_by_default():
    mine, _ = signed_in("a@twilio.com", "a")
    other, _ = signed_in("b@twilio.com", "b", workspace=OTHER, token="sgp_other_token_123456789012")
    key = make(mine, GENERIC).json()["key"]
    assert key in names(mine)
    assert key not in names(other)
    assert other.get(f"/api/templates/{key}").status_code == 404


def test_a_shared_generic_template_is_visible_to_everyone():
    mine, _ = signed_in("a@twilio.com", "a")
    other, _ = signed_in("b@twilio.com", "b", workspace=OTHER, token="sgp_other_token_123456789012")
    key = make(mine, GENERIC, shared_with_company=True).json()["key"]
    assert key in names(other)
    assert other.get(f"/api/templates/{key}").status_code == 200
    assert other.get(f"/api/templates/{key}").json()["owner"] == "shared"


def test_a_shared_locked_template_is_visible_only_to_holders_of_that_workspace():
    mine, _ = signed_in("a@twilio.com", "a")
    outsider, _ = signed_in("b@twilio.com", "b", workspace=OTHER, token="sgp_other_token_123456789012")
    teammate, _ = signed_in("c@twilio.com", "c")  # same workspace as the author
    key = make(mine, OWNED, shared_with_company=True).json()["key"]
    assert key not in names(outsider)
    assert outsider.get(f"/api/templates/{key}").status_code == 404
    assert key in names(teammate)


def test_a_locked_template_is_visible_to_a_holder_whose_tab_is_in_another_group():
    """Holding the workspace is what counts, not which tab is asking."""
    teammate, account = signed_in("c@twilio.com", "c")
    mine, _ = signed_in("a@twilio.com", "a")
    key = make(mine, OWNED, shared_with_company=True).json()["key"]
    assert key in {
        t["key"]
        for t in teammate.get("/api/templates", HTTP_X_WORKSPACE_ID="none").json()["items"]
    }


def test_only_the_author_can_delete_one():
    mine, _ = signed_in("a@twilio.com", "a")
    other, _ = signed_in("b@twilio.com", "b", workspace=OTHER, token="sgp_other_token_123456789012")
    key = make(mine, GENERIC, shared_with_company=True).json()["key"]
    assert other.delete(f"/api/templates/{key}").status_code == 403
    assert Template.objects.filter(pk=key).exists()
    assert mine.delete(f"/api/templates/{key}").status_code == 204
    assert not Template.objects.filter(pk=key).exists()


def test_a_built_in_cannot_be_deleted():
    client, _ = signed_in("a@twilio.com", "a")
    Template.objects.create(key="builtin-x", name="B", graph={"nodes": [], "edges": []}, is_builtin=True)
    assert client.delete("/api/templates/builtin-x").status_code == 403
    assert Template.objects.filter(pk="builtin-x").exists()


def test_built_ins_are_visible_to_everyone():
    client, _ = signed_in("a@twilio.com", "a")
    Template.objects.create(key="builtin-x", name="B", graph={"nodes": [], "edges": []}, is_builtin=True)
    assert "builtin-x" in names(client)


def test_a_template_is_sanitized_like_a_diagram():
    client, _ = signed_in("a@twilio.com", "a")
    graph = {
        "nodes": [
            {
                "id": "a",
                "kind": "source",
                "data": {"kind": "source", "password": "hunter2", "workspaceUrl": None, "docsUrl": "javascript:alert(1)"},
            }
        ],
        "edges": [],
    }
    key = make(client, graph).json()["key"]
    data = Template.objects.get(pk=key).graph["nodes"][0]["data"]
    assert "password" not in data
    assert "docsUrl" not in data


def test_a_malformed_graph_is_refused():
    client, _ = signed_in("a@twilio.com", "a")
    bad = {"nodes": [{"id": "a", "kind": "source"}], "edges": [{"source": "a", "target": "ghost"}]}
    assert make(client, bad).status_code == 400


def test_nobody_without_a_session_can_save_one():
    assert make(APIClient(), GENERIC).status_code in (401, 403)
