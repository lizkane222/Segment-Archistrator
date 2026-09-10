"""
SegmentClient: pagination, error mapping, and the retry predicate.

The retry predicate has its own test because getting it wrong is expensive in a
way that is invisible in normal use -- a bad token would simply appear to hang.
"""

import pytest
import responses

from apps.segmentapi import endpoints as ep
from apps.segmentapi.client import MAX_PAGES, SegmentClient, _build_session
from apps.segmentapi.exceptions import (
    SegmentAuthError,
    SegmentFeatureUnavailable,
    SegmentNotFound,
    SegmentRateLimited,
    SegmentUnavailable,
    SegmentValidationError,
)
from tests.conftest import API_BASE, FAKE_TOKEN


@pytest.fixture
def client():
    return SegmentClient.for_token(FAKE_TOKEN)


# --- retry predicate --------------------------------------------------------

def test_retry_covers_transient_statuses_only():
    """
    429 and 5xx retry; 4xx must not. The script this was modelled on retried
    anything >= 400 twelve times with 2**n backoff, so a 401 burned ~2.3 hours.
    """
    retry = _build_session().get_adapter("https://x/").max_retries
    assert set(retry.status_forcelist) == {429, 500, 502, 503, 504}
    for status in (400, 401, 403, 404, 422):
        assert status not in retry.status_forcelist
    assert retry.respect_retry_after_header is True
    assert retry.total == 5


# --- request / error mapping ------------------------------------------------

@responses.activate
def test_bearer_auth_and_accept_header(client):
    responses.add(responses.GET, f"{API_BASE}/sources", json={"data": {}}, status=200)
    client.request(ep.LIST_SOURCES)
    request = responses.calls[0].request
    assert request.headers["Authorization"] == f"Bearer {FAKE_TOKEN}"
    assert request.headers["Accept"] == ep.ACCEPT_V1


@responses.activate
def test_alpha_endpoints_ask_for_the_alpha_media_type(client):
    """Spaces 404s or 406s if requested with the v1 media type."""
    responses.add(responses.GET, f"{API_BASE}/spaces", json={"data": {}}, status=200)
    client.request(ep.LIST_SPACES)
    assert responses.calls[0].request.headers["Accept"] == ep.ACCEPT_V1ALPHA


@responses.activate
def test_no_v1_prefix_in_the_path(client):
    """The base URL is bare. `/v1/sources` is the most common wrong guess."""
    responses.add(responses.GET, f"{API_BASE}/sources", json={"data": {}}, status=200)
    client.request(ep.LIST_SOURCES)
    assert responses.calls[0].request.url.startswith(f"{API_BASE}/sources")


@responses.activate
def test_destination_filters_path_is_singular(client):
    """`/destination/{id}/filters` -- the one singular path in the API."""
    responses.add(
        responses.GET,
        f"{API_BASE}/destination/dst_1/filters",
        json={"data": {"filters": []}},
        status=200,
    )
    client.list_destination_filters("dst_1")
    assert "/destination/dst_1/filters" in responses.calls[0].request.url


@pytest.mark.parametrize(
    "status,exception",
    [
        (401, SegmentAuthError),
        (403, SegmentAuthError),
        (404, SegmentNotFound),
        (422, SegmentValidationError),
        (500, SegmentUnavailable),
    ],
)
@responses.activate
def test_error_status_mapping(client, status, exception):
    responses.add(responses.GET, f"{API_BASE}/sources", json={}, status=status)
    with pytest.raises(exception):
        client.request(ep.LIST_SOURCES)


@responses.activate
def test_404_on_a_feature_gated_endpoint_means_not_enabled(client):
    """
    A workspace without Unify 404s on /spaces. That is a capability signal, not
    an error -- the canvas should render without Unify rather than fail.
    """
    responses.add(responses.GET, f"{API_BASE}/spaces", json={}, status=404)
    with pytest.raises(SegmentFeatureUnavailable):
        client.request(ep.LIST_SPACES)


@responses.activate
def test_429_distinguishes_endpoint_scope_from_token_scope(client):
    responses.add(
        responses.GET,
        f"{API_BASE}/sources",
        json={"data": {"remainingPoints": 0}},
        status=429,
    )
    with pytest.raises(SegmentRateLimited) as caught:
        client.request(ep.LIST_SOURCES)
    assert caught.value.scope == "endpoint"


@responses.activate
def test_429_token_scope_carries_retry_after(client):
    responses.add(
        responses.GET,
        f"{API_BASE}/sources",
        json={"errors": [{"message": "slow down"}]},
        status=429,
        headers={"Retry-After": "30"},
    )
    with pytest.raises(SegmentRateLimited) as caught:
        client.request(ep.LIST_SOURCES)
    assert caught.value.scope == "token"
    assert caught.value.retry_after == 30


@responses.activate
def test_non_json_success_body_is_not_a_500(client):
    """A proxy error page with a 200 must not escape as a JSONDecodeError."""
    responses.add(responses.GET, f"{API_BASE}/sources", body="<html>oops</html>", status=200)
    with pytest.raises(SegmentUnavailable):
        client.request(ep.LIST_SOURCES)


# --- pagination -------------------------------------------------------------

def _page(items, next_cursor=None):
    return {
        "data": {
            "sources": items,
            "pagination": {"current": "c", "next": next_cursor, "totalEntries": 0},
        }
    }


@responses.activate
def test_pagination_walks_every_page(client):
    responses.add(responses.GET, f"{API_BASE}/sources", json=_page([{"id": "1"}], "cur2"))
    responses.add(responses.GET, f"{API_BASE}/sources", json=_page([{"id": "2"}], "cur3"))
    responses.add(responses.GET, f"{API_BASE}/sources", json=_page([{"id": "3"}], None))

    assert [s["id"] for s in client.list_sources()] == ["1", "2", "3"]


@responses.activate
def test_pagination_params_are_always_sent(client):
    """Several endpoints 422 without them, so the client never omits them."""
    responses.add(responses.GET, f"{API_BASE}/sources", json=_page([], None))
    client.list_sources()
    assert "pagination.count=200" in responses.calls[0].request.url


@responses.activate
def test_pagination_threads_the_cursor(client):
    responses.add(responses.GET, f"{API_BASE}/sources", json=_page([{"id": "1"}], "CURSOR2"))
    responses.add(responses.GET, f"{API_BASE}/sources", json=_page([], None))
    client.list_sources()
    assert "pagination.cursor=CURSOR2" in responses.calls[1].request.url


@responses.activate
def test_pagination_stops_on_a_repeated_cursor(client):
    """A server echoing the same cursor forever must not hang the request."""
    for _ in range(5):
        responses.add(responses.GET, f"{API_BASE}/sources", json=_page([{"id": "x"}], "SAME"))

    items = client.list_sources()
    # First page, then the second under cursor SAME, then the repeat is caught.
    assert len(items) == 2


@responses.activate
def test_pagination_respects_max_items(client):
    responses.add(
        responses.GET,
        f"{API_BASE}/sources",
        json=_page([{"id": str(i)} for i in range(10)], "more"),
    )
    items = list(client.paginate(ep.LIST_SOURCES, item_key="sources", max_items=4))
    assert len(items) == 4


@responses.activate
def test_missing_item_key_yields_nothing_rather_than_raising(client):
    """Alpha endpoints change field names; an unexpected shape must degrade quietly."""
    responses.add(responses.GET, f"{API_BASE}/sources", json={"data": {"pagination": {}}})
    assert client.list_sources() == []


# --- identity ---------------------------------------------------------------

@responses.activate
def test_get_workspace_rejects_a_response_with_no_workspace(client):
    """200 with no workspace means the token lacks scopes -- treat as auth failure."""
    responses.add(responses.GET, f"{API_BASE}/", json={"data": {}}, status=200)
    with pytest.raises(SegmentAuthError):
        client.get_workspace()


@responses.activate
def test_functions_require_a_resource_type(client):
    responses.add(responses.GET, f"{API_BASE}/functions", json={"data": {"functions": []}})
    client.list_functions("SOURCE")
    assert "resourceType=SOURCE" in responses.calls[0].request.url

    with pytest.raises(ValueError):
        client.list_functions("NOT_A_TYPE")


def test_eu_region_uses_the_eu_host():
    assert "eu1" in SegmentClient.for_token(FAKE_TOKEN, region="eu").base_url


def test_unknown_region_falls_back_to_us():
    client = SegmentClient.for_token(FAKE_TOKEN, region="mars")
    assert client.region == "us"


# --- Profile API ------------------------------------------------------------

@responses.activate
def test_profile_api_uses_basic_auth_with_a_trailing_colon():
    """
    The Profile API takes the token as the Basic *username* with an empty
    password -- base64(token + ":"). Bearer auth is rejected there.
    """
    import base64

    from django.conf import settings

    client = SegmentClient.for_token(FAKE_TOKEN)
    responses.add(
        responses.GET,
        f"{settings.SEGMENT_PROFILE_API_BASE}/spaces/spa_1/collections",
        json={"data": []},
    )
    client.profile_request("spa_1", "/collections")

    header = responses.calls[0].request.headers["Authorization"]
    assert header == "Basic " + base64.b64encode(f"{FAKE_TOKEN}:".encode()).decode()


def test_max_pages_guard_is_set():
    """A guard that silently drifts to None would reintroduce the infinite walk."""
    assert isinstance(MAX_PAGES, int) and MAX_PAGES > 0
