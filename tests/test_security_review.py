"""
Regressions from the security review: each test here would have failed before its fix.

  - two people pasting the same Segment token must not end up as one principal;
  - the session cookie's `Secure` flag follows `SESSION_COOKIE_SECURE`;
  - `sanitize_graph` drops a wider set of credential-shaped keys, refuses non-http(s)
    link values (a `javascript:` URL in a shared diagram is script for whoever clicks it),
    and strips userinfo out of URLs;
  - an absurdly nested graph is a 400, not a 500.
"""

import pytest
from rest_framework.test import APIClient

from apps.accounts.models import Account
from apps.auth_workspace.models import RememberedConnection, WorkspaceSession
from apps.diagrams.models import MAX_GRAPH_DEPTH, Diagram, graph_depth, sanitize_graph
from tests.conftest import FAKE_TOKEN, WORKSPACE

pytestmark = pytest.mark.django_db


def account_named(email, sub):
    return Account.objects.create(email=email, google_sub=sub)


# --- the same token, two holders --------------------------------------------


def test_the_same_token_pasted_by_two_people_gives_two_sessions():
    alice = account_named("alice@example.com", "sub-alice")
    bob = account_named("bob@example.com", "sub-bob")
    first = WorkspaceSession.start(
        token=FAKE_TOKEN, workspace=WORKSPACE, account=alice, anon_scope="anon:alice"
    )
    second = WorkspaceSession.start(
        token=FAKE_TOKEN, workspace=WORKSPACE, account=bob, anon_scope="anon:bob"
    )

    assert first.pk != second.pk
    first.refresh_from_db()
    assert first.account_id == alice.id
    assert first.anon_scope == "anon:alice"
    assert second.account_id == bob.id


def test_pasting_a_token_with_no_scope_never_reuses_someone_elses_row():
    alice = account_named("alice@example.com", "sub-alice")
    theirs = WorkspaceSession.start(
        token=FAKE_TOKEN, workspace=WORKSPACE, account=alice, anon_scope="anon:alice"
    )
    stranger = WorkspaceSession.start(token=FAKE_TOKEN, workspace=WORKSPACE)

    assert stranger.pk != theirs.pk
    assert stranger.account_id is None
    assert stranger.anon_scope not in ("", "anon:alice")
    theirs.refresh_from_db()
    assert theirs.account_id == alice.id


def test_the_same_browser_pasting_again_reuses_its_own_row():
    first = WorkspaceSession.start(token=FAKE_TOKEN, workspace=WORKSPACE, anon_scope="anon:me")
    again = WorkspaceSession.start(token=FAKE_TOKEN, workspace=WORKSPACE, anon_scope="anon:me")
    assert first.pk == again.pk


def test_pasting_a_shared_token_does_not_expose_the_first_holders_diagrams(mock_segment, workspace_ok):
    alice = account_named("alice@example.com", "sub-alice")
    theirs = WorkspaceSession.start(
        token=FAKE_TOKEN, workspace=WORKSPACE, account=alice, anon_scope="anon:alice"
    )
    private = Diagram.objects.create(name="Alice private", owner=alice, workspace_id=WORKSPACE["id"])

    stranger = APIClient()
    response = stranger.post("/api/session", {"token": FAKE_TOKEN, "region": "us"}, format="json")
    assert response.status_code == 201
    assert response.cookies["sab_session"].value != str(theirs.id)

    listing = stranger.get("/api/diagrams")
    assert str(private.id) not in [item["id"] for item in listing.json()["items"]]


def test_resuming_a_connection_leaves_another_holders_session_alone():
    alice = account_named("alice@example.com", "sub-alice")
    bob = account_named("bob@example.com", "sub-bob")
    alices = WorkspaceSession.start(
        token=FAKE_TOKEN, workspace=WORKSPACE, account=alice, anon_scope="anon:alice"
    )
    RememberedConnection.remember(alices)

    bobs_remembered = WorkspaceSession.start(
        token=FAKE_TOKEN, workspace=WORKSPACE, account=bob, anon_scope="anon:bob-old"
    )
    remembered = RememberedConnection.remember(bobs_remembered)
    bobs_remembered.delete()
    bobs = WorkspaceSession.start_for_account(bob, anon_scope="anon:bob")
    remembered.apply_to(bobs)

    assert WorkspaceSession.objects.filter(pk=alices.pk).exists()


# --- cookie flags -----------------------------------------------------------


def test_the_session_cookie_is_not_secure_when_https_is_off(settings):
    settings.SESSION_COOKIE_SECURE = False
    response = APIClient().post("/api/session/anonymous")
    assert response.cookies["sab_session"]["secure"] == ""


def test_the_session_cookie_is_secure_when_https_is_on(settings):
    settings.SESSION_COOKIE_SECURE = True
    response = APIClient().post("/api/session/anonymous")
    assert response.cookies["sab_session"]["secure"]
    assert response.cookies["sab_session"]["httponly"]


def test_the_sliding_refresh_follows_the_same_flag(settings, auth_client):
    settings.SESSION_COOKIE_SECURE = True
    response = auth_client.get("/api/session")
    assert response.cookies["sab_session"]["secure"]


# --- sanitize_graph ---------------------------------------------------------


@pytest.mark.parametrize(
    "key",
    [
        "password",
        "passwd",
        "passphrase",
        "privateKey",
        "private_key",
        "accessKey",
        "access-key",
        "Authorization",
        "bearer",
        "cookie",
        "connectionString",
        "connection_string",
        "auth",
        "pwd",
        "dsn",
        "jwt",
        "functionApiKey",
        "clientSecret",
    ],
)
def test_credential_shaped_keys_are_dropped(key):
    graph = {"nodes": [{"id": "n", "data": {"kind": "sql_table", key: "hunter2", "name": "T"}}]}
    data = sanitize_graph(graph)["nodes"][0]["data"]
    assert key not in data
    assert data["name"] == "T"


@pytest.mark.parametrize("key", ["author", "authority", "passenger", "name", "description"])
def test_ordinary_keys_survive(key):
    assert sanitize_graph({key: "x"}) == {key: "x"}


def test_the_masked_write_key_fields_are_still_kept():
    assert sanitize_graph({"writeKeyMasked": "••••1234", "writeKeyLast4": "1234"}) == {
        "writeKeyMasked": "••••1234",
        "writeKeyLast4": "1234",
    }


@pytest.mark.parametrize(
    "value",
    [
        "javascript:alert(1)",
        "JaVaScRiPt:alert(1)",
        " javascript:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "vbscript:msgbox(1)",
        "//evil.example/x",
        "/relative/path",
    ],
)
@pytest.mark.parametrize("key", ["workspaceUrl", "docsUrl", "previewWebhookUrl", "logoUrl", "url", "href"])
def test_a_non_http_link_value_is_dropped(key, value):
    cleaned = sanitize_graph({"data": {key: value, "name": "n"}})
    assert key not in cleaned["data"]
    assert cleaned["data"]["name"] == "n"


@pytest.mark.parametrize("key", ["workspaceUrl", "docsUrl", "previewWebhookUrl"])
def test_an_https_link_value_is_kept(key):
    url = "https://app.segment.com/acme/sources/web"
    assert sanitize_graph({"data": {key: url}}) == {"data": {key: url}}


def test_an_empty_or_null_link_value_is_kept():
    assert sanitize_graph({"workspaceUrl": None, "docsUrl": ""}) == {"workspaceUrl": None, "docsUrl": ""}


def test_userinfo_is_stripped_from_a_url_in_any_field():
    cleaned = sanitize_graph(
        {"nodes": [{"data": {"note": "see postgres://admin:s3cr3t@db.example.com:5432/app for rows"}}]}
    )
    note = cleaned["nodes"][0]["data"]["note"]
    assert "s3cr3t" not in note
    assert "admin" not in note
    assert "db.example.com:5432/app" in note


def test_a_url_without_credentials_is_untouched():
    text = "https://example.com/a:b@c"
    assert sanitize_graph({"note": text}) == {"note": text}


def test_the_unsafe_url_never_reaches_the_database(auth_client):
    graph = {
        "nodes": [
            {
                "id": "a",
                "kind": "source",
                "data": {"kind": "source", "workspaceUrl": "javascript:alert(document.cookie)"},
            }
        ],
        "edges": [],
    }
    created = auth_client.post("/api/diagrams", {"name": "x", "graph": graph}, format="json")
    assert created.status_code == 201
    stored = Diagram.objects.get(pk=created.json()["id"]).graph
    assert "workspaceUrl" not in stored["nodes"][0]["data"]


# --- depth ------------------------------------------------------------------


def nested(depth):
    value = []
    for _ in range(depth):
        value = [value]
    return value


def test_graph_depth_counts_nesting_without_recursing():
    assert graph_depth({"a": nested(10)}) == 12
    assert graph_depth(nested(100_000)) > MAX_GRAPH_DEPTH


def test_a_deeply_nested_graph_is_a_400(auth_client):
    graph = {"nodes": [], "edges": [], "extra": nested(MAX_GRAPH_DEPTH + 5)}
    response = auth_client.post("/api/diagrams", {"name": "deep", "graph": graph}, format="json")
    assert response.status_code == 400


def test_a_graph_at_the_depth_limit_is_accepted(auth_client):
    graph = {"nodes": [], "edges": [], "extra": nested(10)}
    response = auth_client.post("/api/diagrams", {"name": "ok", "graph": graph}, format="json")
    assert response.status_code == 201
