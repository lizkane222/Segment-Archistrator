"""
Who can see and who can change a diagram.

This is the load-bearing security change in the ownership split, so it is tested as a
matrix rather than incidentally. Two boundaries, and they are deliberately not the same
set: `visible_to` decides reading, `editable_by` decides writing, and being *shared*
something grants only the first.

The 404-versus-403 distinction is asserted throughout. A diagram you cannot see must
404, because saying "forbidden" would confirm the id exists; one you can see but do not
own must 403, because telling someone looking at a diagram on their screen that it does
not exist is a lie they cannot act on.
"""

import pytest
from rest_framework.test import APIClient

from apps.accounts.models import Account
from apps.auth_workspace.models import WorkspaceSession
from apps.diagrams.models import Diagram
from tests.conftest import FAKE_TOKEN, WORKSPACE

pytestmark = pytest.mark.django_db

OTHER_WORKSPACE = {"id": "ws_other456", "name": "Globex", "slug": "globex"}


def client_for(session):
    client = APIClient()
    client.cookies["sab_session"] = str(session.id)
    return client


@pytest.fixture
def colleague(db):
    """A second account holding a credential for the *same* workspace."""
    account = Account.objects.create(email="sam@example.com", google_sub="sam-sub")
    session = WorkspaceSession.start(
        token="sgp_sams_token_9876543210", workspace=WORKSPACE, region="us", account=account
    )
    return account, client_for(session)


@pytest.fixture
def outsider(db):
    """An account holding a credential for a different workspace."""
    account = Account.objects.create(email="ada@example.com", google_sub="ada-sub")
    session = WorkspaceSession.start(
        token="sgp_adas_token_5555555555", workspace=OTHER_WORKSPACE, region="us", account=account
    )
    return account, client_for(session)


@pytest.fixture
def mine(account):
    """A connected, signed-in session -- the ordinary state after doing both."""
    session = WorkspaceSession.start(
        token=FAKE_TOKEN, workspace=WORKSPACE, region="us", account=account
    )
    return client_for(session)


# --- Private by default -----------------------------------------------------


def test_my_own_diagram_is_visible_and_editable(mine, account):
    diagram = Diagram.objects.create(owner=account, workspace_id=WORKSPACE["id"], name="Mine")

    assert mine.get(f"/api/diagrams/{diagram.id}").status_code == 200
    assert mine.patch(
        f"/api/diagrams/{diagram.id}", {"name": "Renamed"}, format="json"
    ).status_code == 200


def test_an_unshared_diagram_is_invisible_to_a_colleague_in_the_same_workspace(
    mine, account, colleague
):
    """
    The default that did not exist before: a credential for a workspace no longer means
    reading everything anyone drew about it.
    """
    diagram = Diagram.objects.create(
        owner=account, workspace_id=WORKSPACE["id"], name="Private draft"
    )
    _, their_client = colleague

    assert their_client.get(f"/api/diagrams/{diagram.id}").status_code == 404
    assert their_client.get("/api/diagrams").json()["items"] == []


def test_another_accounts_diagram_cannot_be_written_or_deleted(mine, colleague):
    their_account, _ = colleague
    theirs = Diagram.objects.create(
        owner=their_account, workspace_id=WORKSPACE["id"], name="Theirs"
    )

    assert mine.get(f"/api/diagrams/{theirs.id}").status_code == 404
    assert mine.patch(f"/api/diagrams/{theirs.id}", {"name": "hijacked"}, format="json").status_code == 404
    assert mine.put(f"/api/diagrams/{theirs.id}", {"name": "hijacked", "graph": {}}, format="json").status_code == 404
    assert mine.delete(f"/api/diagrams/{theirs.id}").status_code == 404

    theirs.refresh_from_db()
    assert theirs.name == "Theirs"


# --- Sharing ----------------------------------------------------------------


def test_sharing_makes_it_readable_but_not_writable_by_a_colleague(mine, account, colleague):
    """The distinction between the two boundaries, in one test."""
    diagram = Diagram.objects.create(
        owner=account,
        workspace_id=WORKSPACE["id"],
        shared_with_workspace=True,
        name="Shared",
    )
    _, their_client = colleague

    assert their_client.get(f"/api/diagrams/{diagram.id}").status_code == 200
    assert [d["name"] for d in their_client.get("/api/diagrams").json()["items"]] == ["Shared"]

    refused = their_client.patch(
        f"/api/diagrams/{diagram.id}", {"name": "edited"}, format="json"
    )
    assert refused.status_code == 403
    assert refused.json()["error"]["code"] == "not_your_diagram"
    assert their_client.delete(f"/api/diagrams/{diagram.id}").status_code == 403

    diagram.refresh_from_db()
    assert diagram.name == "Shared"


def test_a_shared_diagram_is_labelled_as_someone_elses(mine, account, colleague):
    Diagram.objects.create(
        owner=account, workspace_id=WORKSPACE["id"], shared_with_workspace=True, name="Shared"
    )
    _, their_client = colleague

    item = their_client.get("/api/diagrams").json()["items"][0]
    # So the open dialog can badge the row and disable Delete rather than offering an
    # action that 403s.
    assert item["owner"] == "shared"
    assert item["shared_with_workspace"] is True


def test_sharing_is_invisible_to_an_account_in_another_workspace(mine, account, outsider):
    diagram = Diagram.objects.create(
        owner=account, workspace_id=WORKSPACE["id"], shared_with_workspace=True, name="Shared"
    )
    _, their_client = outsider

    assert their_client.get(f"/api/diagrams/{diagram.id}").status_code == 404
    assert their_client.get("/api/diagrams").json()["items"] == []


def test_unsharing_removes_access_immediately(mine, account, colleague):
    diagram = Diagram.objects.create(
        owner=account, workspace_id=WORKSPACE["id"], shared_with_workspace=True, name="Shared"
    )
    _, their_client = colleague
    assert their_client.get(f"/api/diagrams/{diagram.id}").status_code == 200

    assert mine.patch(
        f"/api/diagrams/{diagram.id}", {"shared_with_workspace": False}, format="json"
    ).status_code == 200

    assert their_client.get(f"/api/diagrams/{diagram.id}").status_code == 404


def test_sharing_is_refused_for_a_workspace_you_hold_no_credential_for(account_client, account):
    """
    Otherwise anyone could publish a diagram into a workspace they cannot read, putting
    it in front of that workspace's real users.
    """
    diagram = Diagram.objects.create(
        owner=account, workspace_id="ws_not_mine", name="About someone else's workspace"
    )
    response = account_client.patch(
        f"/api/diagrams/{diagram.id}", {"shared_with_workspace": True}, format="json"
    )
    assert response.status_code == 400
    assert "credential" in str(response.json()).lower()

    diagram.refresh_from_db()
    assert diagram.shared_with_workspace is False


def test_sharing_something_about_no_workspace_says_what_to_do(account_client, account):
    diagram = Diagram.objects.create(owner=account, workspace_id="", name="Drawn before connecting")
    response = account_client.patch(
        f"/api/diagrams/{diagram.id}", {"shared_with_workspace": True}, format="json"
    )
    assert response.status_code == 400
    assert "not about a workspace yet" in str(response.json())


def test_sharing_stamps_the_workspace_when_one_is_connected(mine, account):
    """
    `workspace_id` stays unwritable from a body, so turning on sharing is the only way
    it can ever be set after creation.
    """
    diagram = Diagram.objects.create(owner=account, workspace_id="", name="Drawn before connecting")
    assert mine.patch(
        f"/api/diagrams/{diagram.id}", {"shared_with_workspace": True}, format="json"
    ).status_code == 200

    diagram.refresh_from_db()
    assert diagram.workspace_id == WORKSPACE["id"]
    assert diagram.shared_with_workspace is True


def test_workspace_id_is_still_never_taken_from_a_request_body(mine, account):
    """Extends the guarantee test_authz.py makes, now that the field is serialized."""
    created = mine.post(
        "/api/diagrams",
        {"name": "Injected", "graph": {}, "workspace_id": "ws_victim"},
        format="json",
    )
    assert created.status_code == 201
    assert Diagram.objects.get().workspace_id == WORKSPACE["id"]


# --- Anonymous scopes -------------------------------------------------------


def test_an_anonymous_scopes_diagram_is_invisible_to_an_account(anon_client, anon_session, mine):
    Diagram.objects.create(anon_scope=anon_session.anon_scope, name="Drawn anonymously")
    assert mine.get("/api/diagrams").json()["items"] == []
    assert [d["name"] for d in anon_client.get("/api/diagrams").json()["items"]] == [
        "Drawn anonymously"
    ]


def test_a_claimed_diagram_stops_answering_to_the_old_cookie(anon_client, anon_session, account):
    """
    `claim_for_account` clears the scope, so a cookie that resurfaces later cannot still
    reach something an account now owns.
    """
    diagram = Diagram.objects.create(anon_scope=anon_session.anon_scope, name="Claimed")
    assert Diagram.objects.claim_for_account(anon_scope=anon_session.anon_scope, account=account) == 1

    assert anon_client.get(f"/api/diagrams/{diagram.id}").status_code == 404
    diagram.refresh_from_db()
    assert diagram.owner == account and diagram.anon_scope == ""


# --- Rows that predate accounts ---------------------------------------------


def test_a_row_with_no_owner_stays_readable_and_writable_by_a_credential_holder(auth_client):
    """
    What the ownership migration leaves behind: owned by nobody, about a workspace,
    shared. Without the third clause of `editable_by` every diagram in the database
    would become read-only the moment this shipped.
    """
    legacy = Diagram.objects.create(
        workspace_id=WORKSPACE["id"], shared_with_workspace=True, name="From before accounts"
    )

    assert auth_client.get(f"/api/diagrams/{legacy.id}").status_code == 200
    assert auth_client.patch(
        f"/api/diagrams/{legacy.id}", {"name": "Still editable"}, format="json"
    ).status_code == 200

    item = auth_client.get("/api/diagrams").json()["items"][0]
    assert item["owner"] == "unclaimed"


def test_once_claimed_a_legacy_row_is_no_longer_editable_by_others(auth_client, account, colleague):
    legacy = Diagram.objects.create(
        workspace_id=WORKSPACE["id"], shared_with_workspace=True, name="From before accounts"
    )
    Diagram.objects.filter(pk=legacy.pk).update(owner=account)

    _, their_client = colleague
    assert their_client.get(f"/api/diagrams/{legacy.id}").status_code == 200
    assert their_client.patch(
        f"/api/diagrams/{legacy.id}", {"name": "nope"}, format="json"
    ).status_code == 403


# --- The queryset directly --------------------------------------------------


def test_visible_to_returns_nothing_for_a_principal_with_no_claim_at_all(db):
    class Nobody:
        account_id = None
        anon_scope = ""
        connected_workspace_ids = []

    Diagram.objects.create(workspace_id=WORKSPACE["id"], shared_with_workspace=True, name="X")
    assert list(Diagram.objects.visible_to(Nobody())) == []
    assert list(Diagram.objects.visible_to(None)) == []
