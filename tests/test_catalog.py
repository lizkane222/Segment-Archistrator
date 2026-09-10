"""
The catalog: `sync_catalog` and the endpoints that serve what it wrote.

The point of this layer is that browsing the palette costs the customer nothing
against their rate limit, so the tests assert the endpoints never reach Segment.
`responses` is left un-activated in the endpoint tests deliberately -- if a view
tried an HTTP call, it would attempt a real connection and fail loudly.
"""

import pytest
import responses
from django.core.management import call_command
from django.core.management.base import CommandError

from apps.auth_workspace.models import WorkspaceSession
from apps.catalog.models import CatalogComponent
from tests.conftest import API_BASE, FAKE_TOKEN

pytestmark = pytest.mark.django_db


DESTINATION_ENTRIES = [
    {
        "id": "meta_braze",
        "slug": "braze",
        "name": "Braze",
        "description": "Engagement platform",
        "categories": ["CRM", "Email"],
        "logos": {"default": "https://cdn.segment.com/braze.svg"},
    },
    {
        "id": "meta_amplitude",
        "slug": "amplitude",
        "name": "Amplitude",
        "categories": ["Analytics"],
        "logos": {"default": "https://cdn.segment.com/amplitude.svg"},
    },
]


def _catalog_page(key, items):
    return {"data": {key: items, "pagination": {"next": None}}}


def _stub_catalog(destinations=None):
    responses.add(
        responses.GET, f"{API_BASE}/catalog/sources", json=_catalog_page("sourcesCatalog", [])
    )
    responses.add(
        responses.GET,
        f"{API_BASE}/catalog/destinations",
        json=_catalog_page(
            "destinationsCatalog",
            DESTINATION_ENTRIES if destinations is None else destinations,
        ),
    )
    responses.add(
        responses.GET,
        f"{API_BASE}/catalog/warehouses",
        json=_catalog_page("warehousesCatalog", []),
    )


# --- sync_catalog -----------------------------------------------------------

@responses.activate
def test_sync_writes_catalog_rows():
    _stub_catalog()
    call_command("sync_catalog", "--token", FAKE_TOKEN)

    braze = CatalogComponent.objects.get(kind="destination", slug="braze")
    assert braze.name == "Braze"
    assert braze.categories == ["CRM", "Email"]
    assert braze.logo_url.endswith("braze.svg")
    assert braze.raw  # the untouched payload is kept for the inspector


@responses.activate
def test_sync_is_idempotent_and_updates_in_place():
    _stub_catalog()
    call_command("sync_catalog", "--token", FAKE_TOKEN)

    renamed = [{**DESTINATION_ENTRIES[0], "name": "Braze (Actions)"}, DESTINATION_ENTRIES[1]]
    _stub_catalog(destinations=renamed)
    call_command("sync_catalog", "--token", FAKE_TOKEN, "--kind", "destination")

    assert CatalogComponent.objects.filter(kind="destination").count() == 2
    assert CatalogComponent.objects.get(metadata_id="meta_braze").name == "Braze (Actions)"


@responses.activate
def test_sync_never_deletes_entries_that_vanished():
    """
    A destination leaving the catalog must not break diagrams referencing it, so
    the sync only ever adds and updates.
    """
    _stub_catalog()
    call_command("sync_catalog", "--token", FAKE_TOKEN)

    _stub_catalog(destinations=[DESTINATION_ENTRIES[0]])
    call_command("sync_catalog", "--token", FAKE_TOKEN, "--kind", "destination")

    assert CatalogComponent.objects.filter(metadata_id="meta_amplitude").exists()


@responses.activate
def test_sync_can_target_a_single_kind():
    _stub_catalog()
    call_command("sync_catalog", "--token", FAKE_TOKEN, "--kind", "destination")
    paths = [call.request.url for call in responses.calls]
    assert all("/catalog/destinations" in url for url in paths)


@responses.activate
def test_sync_falls_back_to_the_most_recent_session_token(session):
    """
    Local-development convenience: a fresh clone can populate the catalog without
    setting SEGMENT_CATALOG_TOKEN.
    """
    _stub_catalog()
    call_command("sync_catalog")
    assert responses.calls[0].request.headers["Authorization"] == f"Bearer {FAKE_TOKEN}"


@responses.activate
def test_sync_prefers_the_configured_catalog_token_over_a_session(session, settings):
    settings.SEGMENT_CATALOG_TOKEN = "sgp_deploy_token"
    _stub_catalog()
    call_command("sync_catalog")
    assert responses.calls[0].request.headers["Authorization"] == "Bearer sgp_deploy_token"


def test_sync_without_any_token_fails_with_a_useful_message(settings):
    settings.SEGMENT_CATALOG_TOKEN = ""
    with pytest.raises(CommandError, match="No token available"):
        call_command("sync_catalog")


@responses.activate
def test_a_segment_error_becomes_a_command_error_not_a_traceback():
    responses.add(responses.GET, f"{API_BASE}/catalog/sources", json={}, status=401)
    with pytest.raises(CommandError, match="Failed to fetch"):
        call_command("sync_catalog", "--token", "sgp_bad", "--kind", "source")


@responses.activate
def test_entries_without_an_id_are_skipped_rather_than_crashing():
    _stub_catalog(destinations=[{"slug": "nameless", "name": "No id"}, *DESTINATION_ENTRIES])
    call_command("sync_catalog", "--token", FAKE_TOKEN, "--kind", "destination")
    assert CatalogComponent.objects.filter(kind="destination").count() == 2


# --- catalog endpoints ------------------------------------------------------

@pytest.fixture
def seeded_catalog(db):
    for kind, entries in (("destination", DESTINATION_ENTRIES),):
        for raw in entries:
            CatalogComponent.objects.create(
                kind=kind,
                metadata_id=raw["id"],
                slug=raw["slug"],
                name=raw["name"],
                categories=raw.get("categories", []),
                logo_url=raw.get("logos", {}).get("default", ""),
                raw=raw,
            )


def test_catalog_endpoint_serves_from_postgres(auth_client, seeded_catalog):
    body = auth_client.get("/api/catalog/destinations").json()
    assert body["count"] == 2
    assert {item["slug"] for item in body["items"]} == {"braze", "amplitude"}


def test_catalog_endpoint_returns_the_filter_vocabulary(auth_client, seeded_catalog):
    """The palette builds its filter list from this, so it must not need a second call."""
    body = auth_client.get("/api/catalog/destinations").json()
    assert body["categories"] == ["Analytics", "CRM", "Email"]


def test_catalog_search_matches_on_name(auth_client, seeded_catalog):
    body = auth_client.get("/api/catalog/destinations?q=braz").json()
    assert [item["slug"] for item in body["items"]] == ["braze"]


def test_catalog_category_filter_is_a_union_across_repeats(auth_client, seeded_catalog):
    body = auth_client.get("/api/catalog/destinations?category=CRM&category=Analytics").json()
    assert body["count"] == 2

    body = auth_client.get("/api/catalog/destinations?category=Analytics").json()
    assert [item["slug"] for item in body["items"]] == ["amplitude"]


def test_catalog_kinds_do_not_leak_into_each_other(auth_client, seeded_catalog):
    assert auth_client.get("/api/catalog/sources").json()["count"] == 0


def test_catalog_serializer_omits_the_raw_payload(auth_client, seeded_catalog):
    """`raw` is kept in the DB for debugging but is dead weight on the wire."""
    item = auth_client.get("/api/catalog/destinations").json()["items"][0]
    assert "raw" not in item


def test_catalog_fields_are_camel_cased_like_workspace_resources(auth_client, seeded_catalog):
    """
    Catalog entries and workspace resources land in the same palette component, so
    they have to speak the same convention. Otherwise the frontend needs a
    per-source field-name map.
    """
    item = auth_client.get("/api/catalog/destinations?q=braze").json()["items"][0]
    assert {"metadataId", "logoUrl", "docsUrl"} <= set(item)
    assert not any("_" in key for key in item)


# --- write key reveal -------------------------------------------------------

@responses.activate
def test_reveal_returns_the_key_and_writes_an_audit_row(auth_client, session):
    from apps.auth_workspace.models import WriteKeyRevealAudit

    responses.add(
        responses.GET,
        f"{API_BASE}/sources/src_1",
        json={"data": {"source": {"id": "src_1", "writeKey": "REALWRITEKEY"}}},
    )
    response = auth_client.post("/api/workspace/sources/src_1/reveal-write-key")

    assert response.status_code == 200
    assert response.json()["writeKey"] == "REALWRITEKEY"

    audit = WriteKeyRevealAudit.objects.get()
    assert audit.source_id == "src_1"
    assert audit.workspace_id == session.workspace_id


@responses.activate
def test_reveal_is_not_reachable_by_get(auth_client):
    """
    GET would make the key retrievable by a link or an <img> tag and would sit
    outside CSRF protection.
    """
    assert auth_client.get("/api/workspace/sources/src_1/reveal-write-key").status_code == 405


def test_reveal_requires_a_session(client):
    assert client.post("/api/workspace/sources/src_1/reveal-write-key").status_code == 401


@responses.activate
def test_reveal_of_an_unknown_source_404s_without_auditing(auth_client):
    from apps.auth_workspace.models import WriteKeyRevealAudit

    responses.add(responses.GET, f"{API_BASE}/sources/nope", json={}, status=404)
    response = auth_client.post("/api/workspace/sources/nope/reveal-write-key")

    assert response.status_code == 404
    assert WriteKeyRevealAudit.objects.count() == 0


@responses.activate
def test_reveal_is_not_cached(auth_client):
    """
    The whole point is that the plaintext key is never stored here. Two reveals
    must mean two upstream fetches.
    """
    for _ in range(2):
        responses.add(
            responses.GET,
            f"{API_BASE}/sources/src_1",
            json={"data": {"source": {"id": "src_1", "writeKey": "REALWRITEKEY"}}},
        )
    auth_client.post("/api/workspace/sources/src_1/reveal-write-key")
    auth_client.post("/api/workspace/sources/src_1/reveal-write-key")
    assert len(responses.calls) == 2

    from apps.catalog.models import WorkspaceResourceCache

    assert not any(
        "REALWRITEKEY" in str(row.payload)
        for row in WorkspaceResourceCache.objects.all()
    )
