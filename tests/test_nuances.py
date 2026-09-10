"""
Nuances: the operational knowledge that is not in the documentation.

Most of what these tests pin is about what the table *does not* hold. The design
decision is that a nuance carries no workspace attribution -- it is shown to every
workspace, so it must not identify the customer whose setup taught someone the lesson --
and the consequences of that decision are the things worth testing: reads are open,
writes need a session, `status` cannot be set by a submitter, and the length cap is real
because with no attribution there is no throttle to fall back on.
"""

import pytest

from apps.nuances.models import Nuance
from apps.nuances.serializers import MAX_BODY
from apps.segmentapi import topology

pytestmark = pytest.mark.django_db


@pytest.fixture
def nuances():
    return [
        Nuance.objects.create(
            kind="destination",
            body="A mapping has to exist and be enabled before a connection sends anything.",
        ),
        Nuance.objects.create(
            kind="destination",
            slug="braze",
            body="Braze needs the SDK version set before an identify will land.",
        ),
        Nuance.objects.create(
            kind="source",
            body="A write key rotation does not invalidate the old one immediately.",
        ),
    ]


# --- Reading ----------------------------------------------------------------

def test_a_visitor_with_no_session_can_read_them(client, nuances):
    """
    Open, like the topology and the catalog, and for the same reason: there is nothing
    workspace-specific in here to scope. Gating reads on a session would also mean the
    knowledge is least available to the person who has not yet pasted a token, which is
    exactly the person reading a colleague's diagram.
    """
    response = client.get("/api/nuances?kind=destination")
    assert response.status_code == 200
    assert len(response.json()["items"]) == 2


def test_it_answers_for_one_kind_at_a_time(client, nuances):
    response = client.get("/api/nuances?kind=source")
    bodies = [item["body"] for item in response.json()["items"]]
    assert bodies == ["A write key rotation does not invalidate the old one immediately."]


def test_asking_for_no_kind_is_a_refusal_and_not_the_whole_table(client, nuances):
    response = client.get("/api/nuances")
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "kind_required"


def test_a_slug_gets_its_own_notes_and_the_kind_wide_ones(client, nuances):
    """
    Both, deliberately. A nuance about destinations in general is still true of Braze,
    and filtering to the slug alone would mean the most broadly useful notes are the ones
    nobody ever sees.
    """
    response = client.get("/api/nuances?kind=destination&slug=braze")
    slugs = sorted(item["slug"] for item in response.json()["items"])
    assert slugs == ["", "braze"]


def test_a_slug_does_not_see_another_slugs_notes(client, nuances):
    Nuance.objects.create(kind="destination", slug="amplitude", body="Amplitude only.")
    response = client.get("/api/nuances?kind=destination&slug=braze")
    assert "Amplitude only." not in [item["body"] for item in response.json()["items"]]


def test_a_hidden_nuance_is_not_served(client, nuances):
    """
    The only moderation lever a table with no authors can have. If this leaked, there
    would be no way at all to take something back down.
    """
    Nuance.objects.create(kind="destination", body="Wrong, or worse.", status=Nuance.HIDDEN)
    bodies = [
        item["body"] for item in client.get("/api/nuances?kind=destination").json()["items"]
    ]
    assert "Wrong, or worse." not in bodies
    assert len(bodies) == 2


def test_newest_first(client):
    Nuance.objects.create(kind="source", body="Older")
    Nuance.objects.create(kind="source", body="Newer")
    bodies = [item["body"] for item in client.get("/api/nuances?kind=source").json()["items"]]
    assert bodies == ["Newer", "Older"]


# --- Submitting -------------------------------------------------------------

def test_a_session_can_submit(anon_client):
    """
    `HasSession`, not `HasWorkspaceSession`: a Twilion reading a colleague's diagram
    before pasting a token still has something worth writing down.
    """
    response = anon_client.post(
        "/api/nuances/submit",
        {"kind": "audience", "body": "  Recomputing an audience re-sends the whole set.  "},
        format="json",
    )
    assert response.status_code == 201
    assert response.json()["body"] == "Recomputing an audience re-sends the whole set."
    assert response.json()["status"] == Nuance.SUBMITTED


def test_no_session_cannot_submit(client):
    """The session is the only thing standing between this table and the open web."""
    response = client.post(
        "/api/nuances/submit", {"kind": "audience", "body": "Anything."}, format="json"
    )
    assert response.status_code in (401, 403)
    assert Nuance.objects.count() == 0


def test_a_submission_cannot_choose_its_own_status(anon_client):
    """
    Otherwise the one moderation lever is bypassable by anyone who reads the response
    shape and posts `published` back.
    """
    anon_client.post(
        "/api/nuances/submit",
        {"kind": "audience", "body": "Trying it on.", "status": Nuance.PUBLISHED},
        format="json",
    )
    assert Nuance.objects.get().status == Nuance.SUBMITTED


def test_an_unknown_kind_is_refused(anon_client):
    """
    Read off the topology rather than duplicated as `choices`, so a kind added there is
    submittable at once -- and a typo is caught rather than filed against a kind no
    component will ever have.
    """
    response = anon_client.post(
        "/api/nuances/submit", {"kind": "destinaton", "body": "Typo."}, format="json"
    )
    assert response.status_code == 400
    assert "kind" in response.json()["error"]["fields"]


@pytest.mark.parametrize("kind", sorted(set(topology.KINDS) | {"custom"}))
def test_every_kind_on_the_canvas_can_take_a_nuance(anon_client, kind):
    """
    Over the whole table, so a kind added later is submittable without anyone
    remembering to come back here. `custom` is included because it has no topology entry
    by design and someone will have something to say about a customer's own service.
    """
    response = anon_client.post(
        "/api/nuances/submit", {"kind": kind, "body": "Something true."}, format="json"
    )
    assert response.status_code == 201


def test_an_empty_body_is_refused(anon_client):
    response = anon_client.post(
        "/api/nuances/submit", {"kind": "source", "body": "   "}, format="json"
    )
    assert response.status_code == 400
    assert Nuance.objects.count() == 0


def test_the_body_is_capped(anon_client):
    """
    The cap is doing real work, not just guarding the column: with no attribution on the
    table there is no per-submitter throttle to fall back on.
    """
    response = anon_client.post(
        "/api/nuances/submit", {"kind": "source", "body": "x" * (MAX_BODY + 1)}, format="json"
    )
    assert response.status_code == 400
    assert Nuance.objects.count() == 0


# --- What the table deliberately does not hold ------------------------------

def test_a_nuance_records_nothing_about_who_submitted_it(anon_client):
    """
    The design decision, asserted rather than left to the docstring.

    A nuance is shown to every workspace that right-clicks that kind of component. If
    the row recorded the session, then "this breaks when the customer has two spaces"
    would carry the identity of the customer who has two spaces into a table everyone
    reads. A field added later "just for moderation" would undo that silently, so this
    test is here to make it loud.
    """
    anon_client.post(
        "/api/nuances/submit", {"kind": "source", "body": "Anything."}, format="json"
    )
    columns = {field.name for field in Nuance._meta.get_fields()}
    assert not any("workspace" in name or "session" in name for name in columns)
    assert columns == {"id", "kind", "slug", "body", "status", "created_at"}


def test_the_response_carries_no_attribution_either(anon_client, nuances):
    keys = set(anon_client.get("/api/nuances?kind=destination").json()["items"][0])
    assert keys == {"id", "kind", "slug", "body", "status", "createdAt"}
