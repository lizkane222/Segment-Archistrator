"""
Connecting a workspace with an app session `auth_token`, the second way in.

Two things carry most of this file, and neither is the happy path:

  - The credential is somebody's *login session*, not a scoped read-only token. So the tests
    that matter are the ones pinning the narrowness: mutations refused before any network call,
    one request per second, and no route from an auth_token to the Public API.
  - An auth_token is a *person*, and a person is in many workspaces. A Public API token names
    exactly one workspace and `GET /` says which; this one cannot, so "which workspace?" is a
    question the flow has to ask rather than an answer it may guess at.
"""

import time
from unittest.mock import patch

import pytest
import responses as responses_lib

from apps.auth_workspace.models import OperatorWorkspaceBookmark, WorkspaceSession
from apps.segmentapi import graphql as gql
from apps.segmentapi.exceptions import SegmentAuthError, SegmentError
from apps.segmentapi.graphql import SegmentGraphQLClient

pytestmark = pytest.mark.django_db

GRAPHQL_URL = "https://app.segment.com/gateway-api/graphql"
# A shape rather than a real JWT: nothing here decodes it, and a real one would be a credential
# checked into the repository.
FAKE_AUTH_TOKEN = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c3JfMSJ9.not-a-real-signature"

ONE = [{"id": "ws_solo", "slug": "solo-co", "name": "Solo Co", "region": "us"}]
MANY = [
    {"id": "ws_b", "slug": "beta", "name": "Beta Industries", "region": "us"},
    {"id": "ws_a", "slug": "acme", "name": "Acme Corp", "region": "us"},
]


@pytest.fixture(autouse=True)
def no_throttle_sleep():
    """
    Let the throttle run its arithmetic but not its sleep.

    Patched for every test in this file, because a suite that honoured a one-second floor would
    take a second per request to no purpose. The throttle's own behaviour is tested directly
    below, where the sleep is what is being asserted on.
    """
    with patch.object(gql.time, "sleep") as sleep:
        yield sleep


@pytest.fixture(autouse=True)
def reset_throttle_clock():
    """
    Zero the module's last-request timestamp between tests.

    It is process-global state, so without this the first request of each test would be
    throttled against the last request of the previous one -- which makes the throttle tests
    pass or fail depending on what ran before them.
    """
    gql._last_request_at = 0.0
    yield
    gql._last_request_at = 0.0


def graphql_reply(mock, workspaces=None, *, errors=None, status=200, body=None):
    mock.add(
        responses_lib.POST,
        GRAPHQL_URL,
        json=body if body is not None else ({"errors": errors} if errors else {"data": {"workspaces": workspaces}}),
        status=status,
    )
    return mock


def connect(client, **extra):
    payload = {"token": FAKE_AUTH_TOKEN, "region": "us", "credential": "graphql"}
    payload.update(extra)
    return client.post("/api/session", payload, format="json")


# --- the client is read-only ------------------------------------------------


def test_a_mutation_is_refused_before_any_network_call(mock_segment):
    """
    The guard that matters most, and it is deliberately not a SegmentError.

    An `except SegmentError` written to handle a flaky gateway must not swallow this: sending a
    mutation with somebody's login session is a bug in this code, not a response from Segment.
    No request is registered on the mock, so `assert_all_requests_are_fired` proves nothing was
    sent.
    """
    client = SegmentGraphQLClient(FAKE_AUTH_TOKEN)
    with pytest.raises(ValueError, match="read-only"):
        client.query("mutation DeleteEverything { deleteWorkspace(id: 1) }")
    assert len(mock_segment.calls) == 0


def test_a_subscription_is_refused_too():
    """Not a read that finishes, and this client has no business holding one open."""
    client = SegmentGraphQLClient(FAKE_AUTH_TOKEN)
    with pytest.raises(ValueError, match="read-only"):
        client.query("subscription Live { workspaceUpdated { id } }")


def test_the_word_mutation_inside_a_query_is_still_refused():
    """
    Conservative on purpose.

    The check is a word match, so a query with a field called `mutationCount` is refused even
    though it is harmless. That is the right way round: the cost is a caller having to rename
    something, and the cost of the other error is a write against a customer's workspace.
    """
    client = SegmentGraphQLClient(FAKE_AUTH_TOKEN)
    with pytest.raises(ValueError):
        client.query("query Counts { mutation }")


def test_the_query_it_actually_sends_is_a_query():
    assert "mutation" not in gql.WORKSPACES_QUERY.lower()
    assert gql.WORKSPACES_QUERY.strip().startswith("query")


# --- the credential goes where the gateway expects it -----------------------


def test_the_token_is_sent_as_a_bearer_header(mock_segment):
    """
    A header, not a Cookie.

    `middleware/auth.ts`'s `getAuthToken` checks `Authorization` first and only falls back to
    the cookie -- and reading the cookie server-side additionally needs the gateway's
    `x-requested-with` CSRF stand-in (`middleware/segment-cookies.ts`). The bearer header avoids
    that entirely, so this is pinned rather than left to be rediscovered.
    """
    graphql_reply(mock_segment, ONE)
    SegmentGraphQLClient(FAKE_AUTH_TOKEN).list_workspaces()

    request = mock_segment.calls[0].request
    assert request.headers["Authorization"] == f"Bearer {FAKE_AUTH_TOKEN}"
    assert "Cookie" not in request.headers


def test_the_eu_region_goes_to_the_eu_app_host(mock_segment):
    """Both hosts come from the gateway's own origin allowlist (`allowlists.ts`)."""
    mock_segment.add(
        responses_lib.POST,
        "https://eu1.app.segment.com/gateway-api/graphql",
        json={"data": {"workspaces": ONE}},
        status=200,
    )
    SegmentGraphQLClient(FAKE_AUTH_TOKEN, region="eu").list_workspaces()
    assert "eu1.app.segment.com" in mock_segment.calls[0].request.url


def test_an_unknown_region_falls_back_to_us():
    assert SegmentGraphQLClient(FAKE_AUTH_TOKEN, region="mars").region == "us"


def test_the_operation_name_is_on_the_query_string(mock_segment):
    """So these requests are identifiable in Segment's own logs rather than anonymous."""
    graphql_reply(mock_segment, ONE)
    SegmentGraphQLClient(FAKE_AUTH_TOKEN).list_workspaces()
    assert "operation=segment_builder_workspaces" in mock_segment.calls[0].request.url


# --- one request per second -------------------------------------------------


def test_a_second_request_waits_out_the_interval(mock_segment, no_throttle_sleep):
    graphql_reply(mock_segment, ONE)
    graphql_reply(mock_segment, ONE)
    client = SegmentGraphQLClient(FAKE_AUTH_TOKEN)

    client.list_workspaces()
    client.list_workspaces()

    # Once, not twice. The first request does not wait, and that falls out of using a monotonic
    # clock rather than being special-cased: a zeroed timestamp is an elapsed time of "however
    # long this machine has been up", which is correctly read as "no request owed a wait".
    assert no_throttle_sleep.call_count == 1
    # For no longer than the interval. The exact figure is a clock delta, so pinning it would
    # make this a timing test rather than a test of the arithmetic.
    assert 0 < no_throttle_sleep.call_args.args[0] <= gql.MIN_INTERVAL_SECONDS


def test_a_request_after_the_interval_does_not_wait(mock_segment, no_throttle_sleep):
    graphql_reply(mock_segment, ONE)
    # Far enough in the past that no wait is owed.
    gql._last_request_at = time.monotonic() - 10
    SegmentGraphQLClient(FAKE_AUTH_TOKEN).list_workspaces()
    assert no_throttle_sleep.call_count == 0


def test_the_throttle_is_shared_between_clients(mock_segment, no_throttle_sleep):
    """
    Two clients, one ceiling.

    Per-instance state would make the limit meaningless: the view builds a fresh client per
    request, so every request would see a zeroed clock and none would ever wait.
    """
    graphql_reply(mock_segment, ONE)
    graphql_reply(mock_segment, ONE)
    gql._last_request_at = time.monotonic()

    SegmentGraphQLClient(FAKE_AUTH_TOKEN).list_workspaces()
    SegmentGraphQLClient(FAKE_AUTH_TOKEN).list_workspaces()
    assert no_throttle_sleep.call_count == 2


# --- what the gateway's answers mean ---------------------------------------


def test_a_rejected_token_is_an_auth_error(mock_segment):
    graphql_reply(mock_segment, status=401, body={})
    with pytest.raises(SegmentAuthError, match="expired"):
        SegmentGraphQLClient(FAKE_AUTH_TOKEN).list_workspaces()


def test_a_400_is_an_auth_error_too(mock_segment):
    """
    `auth.ts` throws `BadRequest` for a token it cannot decode.

    So an expired or truncated paste arrives as a 400, and reporting it as a server fault would
    send the user looking in entirely the wrong place.
    """
    graphql_reply(mock_segment, status=400, body={})
    with pytest.raises(SegmentAuthError):
        SegmentGraphQLClient(FAKE_AUTH_TOKEN).list_workspaces()


def test_an_unauthorised_error_in_a_200_body_is_an_auth_error(mock_segment):
    """
    GraphQL reports authorisation failures as a 200 with an error in the body.

    Without this the user would be told their workspace list was empty rather than that their
    credential was refused -- which is the same class of bug as a silent catch.
    """
    graphql_reply(mock_segment, errors=[{"message": "Unauthorized: token has no viewer"}])
    with pytest.raises(SegmentAuthError, match="not allowed"):
        SegmentGraphQLClient(FAKE_AUTH_TOKEN).list_workspaces()


def test_any_other_graphql_error_is_not_an_auth_error(mock_segment):
    graphql_reply(mock_segment, errors=[{"message": "Field 'nope' does not exist"}])
    with pytest.raises(SegmentError, match="does not exist"):
        SegmentGraphQLClient(FAKE_AUTH_TOKEN).list_workspaces()


def test_a_token_that_sees_no_workspaces_is_refused_with_a_reason(mock_segment):
    graphql_reply(mock_segment, [])
    with pytest.raises(SegmentAuthError, match="no workspaces"):
        SegmentGraphQLClient(FAKE_AUTH_TOKEN).list_workspaces()


def test_a_workspace_missing_an_id_is_skipped_rather_than_crashing(mock_segment):
    graphql_reply(mock_segment, [{"slug": "broken"}, *ONE])
    found = SegmentGraphQLClient(FAKE_AUTH_TOKEN).list_workspaces()
    assert [entry["id"] for entry in found] == ["ws_solo"]


# --- the connect flow ------------------------------------------------------


def test_one_visible_workspace_connects_without_asking(twilio_client, mock_segment):
    """The commonest case for a customer-facing login. A list of one is ceremony."""
    graphql_reply(mock_segment, ONE)
    response = connect(twilio_client)

    assert response.status_code == 201
    assert response.json()["workspace"]["slug"] == "solo-co"
    session = WorkspaceSession.objects.get()
    assert session.credential_kind == WorkspaceSession.CREDENTIAL_GRAPHQL
    assert session.workspace_id == "ws_solo"


def test_several_visible_workspaces_ask_which_one(twilio_client, mock_segment):
    """
    A choice, not an error -- so a 200 with the list, and no session yet.

    Connecting to whichever sorted first would put a solutions engineer on the wrong customer's
    workspace, which is the one outcome here that would be actively harmful.
    """
    graphql_reply(mock_segment, MANY)
    response = connect(twilio_client)

    assert response.status_code == 200
    body = response.json()
    assert body["needsChoice"] is True
    # Sorted by name, so a person in two hundred workspaces gets something scannable.
    assert [entry["slug"] for entry in body["workspaces"]] == ["acme", "beta"]
    # Not zero: the account's own tokenless session already exists. No *connected* one, though.
    assert WorkspaceSession.objects.filter(encrypted_token__isnull=False).count() == 0


def test_the_chosen_workspace_is_the_one_connected(twilio_client, mock_segment):
    graphql_reply(mock_segment, MANY)
    response = connect(twilio_client, workspace_id="ws_a")

    assert response.status_code == 201
    assert WorkspaceSession.objects.get().workspace_id == "ws_a"


def test_a_workspace_the_token_cannot_see_is_refused(twilio_client, mock_segment):
    """Not silently substituted, and not a 500. The credential changed under the twilio_client."""
    graphql_reply(mock_segment, MANY)
    response = connect(twilio_client, workspace_id="ws_someone_elses")

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "workspace_not_visible"
    # Not zero: the account's own tokenless session already exists. No *connected* one, though.
    assert WorkspaceSession.objects.filter(encrypted_token__isnull=False).count() == 0


def test_a_rejected_auth_token_leaves_no_session(twilio_client, mock_segment):
    graphql_reply(mock_segment, status=401, body={})
    response = connect(twilio_client)

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "invalid_token"
    # Not zero: the account's own tokenless session already exists. No *connected* one, though.
    assert WorkspaceSession.objects.filter(encrypted_token__isnull=False).count() == 0


def test_a_gateway_fault_is_not_reported_as_a_bad_token(twilio_client, mock_segment):
    """
    502, not 401.

    The credential worked and Segment answered; telling the user their token was invalid would
    send them to re-copy something that is fine.
    """
    graphql_reply(mock_segment, errors=[{"message": "downstream service timed out"}])
    response = connect(twilio_client)

    assert response.status_code == 502
    assert response.json()["error"]["code"] == "graphql_error"


def test_the_workspaces_own_region_wins_over_the_dialogs_guess(twilio_client, mock_segment):
    """
    A person's auth_token can see workspaces in both regions, so the radio button is a guess and
    the gateway's answer is the fact. Storing the guess would point every later read at the
    wrong host.
    """
    mock_segment.add(
        responses_lib.POST,
        GRAPHQL_URL,
        json={"data": {"workspaces": [{**ONE[0], "region": "eu"}]}},
        status=200,
    )
    connect(twilio_client, region="us")
    assert WorkspaceSession.objects.get().region == "eu"


def test_the_auth_token_is_never_returned_to_the_browser(twilio_client, mock_segment):
    graphql_reply(mock_segment, ONE)
    body = connect(twilio_client).content.decode()
    assert FAKE_AUTH_TOKEN not in body
    # Nor any leading chunk of it. A JWT's header is shared between all of them, so a prefix
    # check has to be long enough to be about *this* token.
    assert FAKE_AUTH_TOKEN[:40] not in body


def test_a_long_jwt_is_not_truncated_by_the_serializer(twilio_client, mock_segment):
    """
    A Public API token is short; an auth_token is a JWT carrying a session's claims and runs
    past 1KB. Truncating one surfaces as "Segment rejected that token", which sends the user to
    re-copy something they had copied correctly.
    """
    long_token = "eyJhbGciOiJIUzI1NiJ9." + ("x" * 1500) + ".sig"
    graphql_reply(mock_segment, ONE)
    response = twilio_client.post(
        "/api/session",
        {"token": long_token, "region": "us", "credential": "graphql"},
        format="json",
    )
    assert response.status_code == 201
    assert mock_segment.calls[0].request.headers["Authorization"] == f"Bearer {long_token}"


# --- the boundary of what a GraphQL session can do -------------------------


def test_a_graphql_session_reads_the_connections_spine(twilio_client, mock_segment):
    """
    A GraphQL session can now load a workspace -- the Connections spine of it.

    This used to be a 403 with "connect a Public API token", because no read had a GraphQL
    equivalent. `build_graph_via_graphql` is that equivalent for sources, destinations, warehouses
    and their connections, so the refusal has become a partial answer.
    """
    graphql_reply(mock_segment, ONE)
    connect(twilio_client)

    graphql_reply(
        mock_segment,
        body={
            "data": {
                "workspace": {
                    "id": "ws_solo",
                    "slug": "solo-co",
                    "name": "Solo Co",
                    "region": "us",
                    "sources": [
                        {
                            "id": "src_1",
                            "slug": "web",
                            "name": "Web",
                            "enabled": True,
                            "metadata": {"id": "m1", "name": "Javascript", "slug": "javascript"},
                            "integrations": [
                                {"id": "dst_1", "name": "Braze", "enabled": True, "metadataId": "md1"}
                            ],
                            "warehouses": [{"id": "wh_1", "name": "Snowflake", "enabled": True}],
                        }
                    ],
                    "warehouses": [{"id": "wh_1", "name": "Snowflake", "enabled": True}],
                }
            }
        },
    )

    response = twilio_client.get("/api/workspace/graph")
    assert response.status_code == 200
    graph = response.json()

    kinds = {node["kind"] for node in graph["nodes"]}
    assert kinds == {"source", "destination", "warehouse"}
    # One warehouse node, not two: it arrives both under the source and at workspace level, and the
    # graph wants one node with an edge rather than a duplicate.
    assert len([n for n in graph["nodes"] if n["kind"] == "warehouse"]) == 1
    # And the connections came back with the sources rather than needing a call each.
    assert len(graph["edges"]) == 2


def test_the_graphql_graph_says_what_it_could_not_read(twilio_client, mock_segment):
    """
    The load-bearing half. Four of the six resource families have no GraphQL equivalent here, and
    shipping the other two silently would leave someone concluding the workspace has no Unify --
    a wrong fact about the customer rather than a gap in this tool.
    """
    graphql_reply(mock_segment, ONE)
    connect(twilio_client)
    graphql_reply(
        mock_segment,
        body={
            "data": {
                "workspace": {"id": "ws_solo", "slug": "solo-co", "name": "Solo Co", "region": "us", "sources": [], "warehouses": []}
            }
        },
    )

    warnings = " ".join(twilio_client.get("/api/workspace/graph").json()["warnings"])
    assert "GraphQL" in warnings
    for absent in ("functions", "Reverse ETL", "Unify", "audiences", "computed traits"):
        assert absent in warnings, absent
    assert "this tool's limitation" in warnings


def test_an_edge_to_something_the_query_did_not_return_is_dropped(twilio_client, mock_segment):
    """
    An edge to a node that is not in the graph renders as a line to nothing, which reads as a broken
    diagram rather than a partial one -- and the save-time validator rejects it outright.
    """
    graphql_reply(mock_segment, ONE)
    connect(twilio_client)
    graphql_reply(
        mock_segment,
        body={
            "data": {
                "workspace": {
                    "id": "ws_solo",
                    "slug": "solo-co",
                    "name": "Solo Co",
                    "region": "us",
                    "sources": [
                        {
                            "id": "src_1",
                            "slug": "web",
                            "name": "Web",
                            "enabled": True,
                            "metadata": {"id": "m1", "name": "Javascript", "slug": "javascript"},
                            # Malformed: no id, so no node is emitted for it.
                            "integrations": [{"name": "Nameless", "enabled": True}],
                            "warehouses": [],
                        }
                    ],
                    "warehouses": [],
                }
            }
        },
    )

    graph = twilio_client.get("/api/workspace/graph").json()
    known = {node["id"] for node in graph["nodes"]}
    for edge in graph["edges"]:
        assert edge["source"] in known and edge["target"] in known


def test_a_public_api_session_still_reads_the_workspace(auth_client, workspace_ok):
    """The other half: the tightened permission must not refuse the sessions it is for."""
    assert auth_client.get("/api/session").json()["workspace"]["canReadWorkspace"] is True


def test_the_session_payload_says_which_credential_it_holds(twilio_client, mock_segment):
    graphql_reply(mock_segment, ONE)
    connect(twilio_client)

    workspace = twilio_client.get("/api/session").json()["workspace"]
    assert workspace["credential"] == "graphql"
    assert workspace["canReadWorkspace"] is False


def test_the_default_credential_is_the_public_api_one(client, workspace_ok):
    """
    A client written before the second option existed keeps working unchanged -- and the
    fallback is the credential that is scoped and revocable, which is the safer default if the
    field is ever lost in transit.
    """
    from tests.conftest import FAKE_TOKEN

    response = client.post("/api/session", {"token": FAKE_TOKEN, "region": "us"}, format="json")
    assert response.status_code == 201
    assert WorkspaceSession.objects.get().credential_kind == "public_api"


# --- the GraphQL credential is limited to Twilio accounts -------------------


def test_graphql_is_refused_for_a_signed_out_visitor(client, mock_segment):
    """No account at all -- the commonest way to reach this gate."""
    response = connect(client)
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "graphql_not_allowed"
    assert len(mock_segment.calls) == 0


def test_graphql_is_refused_for_a_non_twilio_account(account_client, mock_segment):
    """Signed in, but `account`'s email is `@example.com` -- still refused."""
    response = connect(account_client)
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "graphql_not_allowed"
    assert len(mock_segment.calls) == 0


def test_graphql_is_allowed_for_a_twilio_account(twilio_client, mock_segment):
    graphql_reply(mock_segment, ONE)
    assert connect(twilio_client).status_code == 201


def test_the_public_api_credential_is_not_gated_by_email(client, workspace_ok):
    """The gate is specific to `credential=graphql` -- a Public API token needs no account at all."""
    from tests.conftest import FAKE_TOKEN

    response = client.post("/api/session", {"token": FAKE_TOKEN, "region": "us"}, format="json")
    assert response.status_code == 201


# --- Segment's own tooling workspaces are never shown ------------------------

TOOLING = [
    {"id": "ws_admin", "slug": "segment-admin", "name": "Segment Admin", "region": "us"},
    {"id": "ws_eng", "slug": "segment-engineering", "name": "Segment Engineering", "region": "us"},
    {"id": "ws_seg", "slug": "segment", "name": "Segment", "region": "us"},
]
OPERATOR = {"id": "ws_op", "slug": "segment-operator", "name": "Segment Operator", "region": "us"}


def test_admin_engineering_and_segment_never_appear_in_the_list(twilio_client, mock_segment):
    graphql_reply(mock_segment, [*MANY, *TOOLING])
    body = connect(twilio_client).json()

    slugs = {entry["slug"] for entry in body["workspaces"]}
    assert slugs == {"acme", "beta"}


def test_a_hidden_slug_cannot_be_connected_to_even_by_id(twilio_client, mock_segment):
    """Not just hidden from the list -- refused outright if somehow chosen."""
    graphql_reply(mock_segment, [*ONE, *TOOLING])
    response = connect(twilio_client, workspace_id="ws_admin")

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "workspace_not_visible"
    assert WorkspaceSession.objects.filter(encrypted_token__isnull=False).count() == 0


# --- segment-operator is a gateway, not a workspace --------------------------


def test_segment_operator_appears_in_the_list_like_any_other_workspace(twilio_client, mock_segment):
    graphql_reply(mock_segment, [*MANY, OPERATOR])
    body = connect(twilio_client).json()
    assert "segment-operator" in {entry["slug"] for entry in body["workspaces"]}


def test_clicking_segment_operator_asks_for_a_slug_instead_of_connecting(twilio_client, mock_segment):
    graphql_reply(mock_segment, [OPERATOR])
    response = connect(twilio_client, workspace_id="ws_op")

    assert response.status_code == 200
    assert response.json()["needsSlug"] is True
    assert WorkspaceSession.objects.filter(encrypted_token__isnull=False).count() == 0


def test_resolving_a_slug_bookmarks_it_and_reoffers_the_choice(twilio_client, mock_segment, twilio_account):
    graphql_reply(mock_segment, [OPERATOR])
    graphql_reply(mock_segment, body={"data": {"workspace": {**ONE[0]}}})

    response = connect(twilio_client, workspace_slug="solo-co")

    assert response.status_code == 200
    body = response.json()
    assert body["needsChoice"] is True
    assert "solo-co" in {entry["slug"] for entry in body["workspaces"]}
    # No session yet -- resolving the slug adds it to the list, it does not connect.
    assert WorkspaceSession.objects.filter(encrypted_token__isnull=False).count() == 0

    bookmark = OperatorWorkspaceBookmark.objects.get(account=twilio_account)
    assert bookmark.slug == "solo-co"
    assert bookmark.workspace_id == "ws_solo"


def test_an_unresolvable_slug_is_refused_without_being_bookmarked(twilio_client, mock_segment, twilio_account):
    graphql_reply(mock_segment, [OPERATOR])
    graphql_reply(mock_segment, body={"data": {"workspace": None}})

    response = connect(twilio_client, workspace_slug="not-a-real-workspace")

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "workspace_not_visible"
    assert not OperatorWorkspaceBookmark.objects.filter(account=twilio_account).exists()


def test_a_bookmarked_workspace_reappears_on_a_later_connect(twilio_client, mock_segment, twilio_account):
    OperatorWorkspaceBookmark.objects.create(
        account=twilio_account,
        slug="solo-co",
        workspace_id="ws_solo",
        workspace_name="Solo Co",
        region="us",
    )
    # This token's raw list doesn't include it -- the bookmark is what puts it in the merged list.
    graphql_reply(mock_segment, [OPERATOR])
    body = connect(twilio_client).json()
    assert "solo-co" in {entry["slug"] for entry in body["workspaces"]}


def test_a_bookmarked_workspace_is_re_verified_before_connecting(twilio_client, mock_segment, twilio_account):
    """
    A bookmark is cached, not authorization. The token attached to *this* request has to be
    able to see it right now, not merely have been able to at some point in the past.
    """
    OperatorWorkspaceBookmark.objects.create(
        account=twilio_account,
        slug="solo-co",
        workspace_id="ws_solo",
        workspace_name="Solo Co",
        region="us",
    )
    graphql_reply(mock_segment, [OPERATOR])
    graphql_reply(mock_segment, body={"data": {"workspace": {**ONE[0]}}})

    response = connect(twilio_client, workspace_id="ws_solo")

    assert response.status_code == 201
    assert WorkspaceSession.objects.get(encrypted_token__isnull=False).workspace_id == "ws_solo"


def test_a_bookmarked_workspace_no_longer_reachable_is_rejected(twilio_client, mock_segment, twilio_account):
    OperatorWorkspaceBookmark.objects.create(
        account=twilio_account,
        slug="solo-co",
        workspace_id="ws_solo",
        workspace_name="Solo Co",
        region="us",
    )
    graphql_reply(mock_segment, [OPERATOR])
    # The re-verification call finds nothing this time -- access was revoked since it was bookmarked.
    graphql_reply(mock_segment, body={"data": {"workspace": None}})

    response = connect(twilio_client, workspace_id="ws_solo")

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "workspace_not_visible"
    assert WorkspaceSession.objects.filter(encrypted_token__isnull=False).count() == 0


def test_a_signed_out_visitor_resolving_a_slug_gets_it_this_time_only(mock_segment):
    """
    No account, so nothing to save the bookmark under -- but the resolve itself still succeeds
    for this attempt. (The gate on `credential=graphql` needing a Twilio account still applies;
    this exercises the merge/bookmark logic in isolation.)
    """
    from apps.auth_workspace.views import SessionView

    graphql_reply(mock_segment, [OPERATOR])
    graphql_reply(mock_segment, body={"data": {"workspace": {**ONE[0]}}})

    outcome = SessionView()._workspace_from_graphql(
        FAKE_AUTH_TOKEN, region="us", chosen="", chosen_slug="solo-co", account=None
    )
    assert OperatorWorkspaceBookmark.objects.count() == 0
    assert outcome.data["needsChoice"] is True
    assert "solo-co" in {entry["slug"] for entry in outcome.data["workspaces"]}
