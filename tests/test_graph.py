"""
The read-through cache and the graph assembler.

The cache tests matter because of the upstream rate limits: computed traits and
the whole Space Schema surface allow 25 requests/minute, and a canvas render can
easily want more than that. A regression that turns the cache into a pass-through
would not fail loudly -- it would just start 429ing on large workspaces.
"""

import pytest
import responses

from apps.catalog import resources
from apps.catalog.models import WorkspaceResourceCache
from apps.diagrams.models import Diagram, sanitize_graph
from apps.segmentapi import topology
from tests.conftest import API_BASE, WORKSPACE

pytestmark = pytest.mark.django_db


def _list_page(key, items):
    return {"data": {key: items, "pagination": {"next": None}}}


# --- caching ----------------------------------------------------------------

@responses.activate
def test_second_read_is_served_from_cache(session):
    responses.add(
        responses.GET,
        f"{API_BASE}/sources",
        json=_list_page("sources", [{"id": "src_1", "slug": "web", "metadata": {"slug": "javascript"}}]),
    )

    first = resources.get_sources(session)
    second = resources.get_sources(session)

    assert first == second
    assert len(responses.calls) == 1, "the cache was bypassed"


@responses.activate
def test_refresh_bypasses_the_cache(session):
    for _ in range(2):
        responses.add(responses.GET, f"{API_BASE}/sources", json=_list_page("sources", []))

    resources.get_sources(session)
    resources.get_sources(session, refresh=True)
    assert len(responses.calls) == 2


@responses.activate
def test_expired_cache_refetches(session):
    from datetime import timedelta

    from django.utils import timezone

    for _ in range(2):
        responses.add(responses.GET, f"{API_BASE}/sources", json=_list_page("sources", []))

    resources.get_sources(session)
    WorkspaceResourceCache.objects.filter(resource_type="sources").update(
        expires_at=timezone.now() - timedelta(seconds=1)
    )
    resources.get_sources(session)
    assert len(responses.calls) == 2


@responses.activate
def test_space_schema_gets_a_longer_ttl_than_ordinary_resources(session, settings):
    responses.add(responses.GET, f"{API_BASE}/sources", json=_list_page("sources", []))
    responses.add(
        responses.GET, f"{API_BASE}/spaces/spa_1/traits", json=_list_page("traits", [])
    )

    resources.get_sources(session)
    resources.get_space_traits(session, "spa_1")

    sources_row = WorkspaceResourceCache.objects.get(resource_type="sources")
    traits_row = WorkspaceResourceCache.objects.get(resource_type="space_traits:spa_1")
    assert traits_row.expires_at > sources_row.expires_at
    assert settings.SPACE_SCHEMA_CACHE_TTL > settings.WORKSPACE_CACHE_TTL


@responses.activate
def test_a_missing_feature_is_cached_as_empty(session):
    """
    A workspace without Reverse ETL 404s. Asking again in 30 seconds will not
    change that, so the empty result is cached and the canvas renders without it.
    """
    responses.add(responses.GET, f"{API_BASE}/reverse-etl-models", json={}, status=404)

    assert resources.get_reverse_etl_models(session) == []
    assert resources.get_reverse_etl_models(session) == []
    assert len(responses.calls) == 1


@responses.activate
def test_space_scoped_caches_do_not_collide(session):
    responses.add(
        responses.GET,
        f"{API_BASE}/spaces/spa_A/audiences",
        json=_list_page("audiences", [{"id": "aud_a", "name": "A"}]),
    )
    responses.add(
        responses.GET,
        f"{API_BASE}/spaces/spa_B/audiences",
        json=_list_page("audiences", [{"id": "aud_b", "name": "B"}]),
    )

    a = resources.get_audiences(session, "spa_A")
    b = resources.get_audiences(session, "spa_B")
    assert a[0]["name"] == "A"
    assert b[0]["name"] == "B"


def test_cache_is_scoped_per_workspace(session, db):
    from apps.auth_workspace.models import WorkspaceSession

    other = WorkspaceSession.start(
        token="sgp_other_token",
        workspace={"id": "ws_other", "name": "Other", "slug": "other"},
    )
    WorkspaceResourceCache.put(session.workspace_id, "sources", [{"id": "mine"}], 300)

    assert WorkspaceResourceCache.get_fresh(other.workspace_id, "sources") is None
    assert WorkspaceResourceCache.get_fresh(session.workspace_id, "sources") == [{"id": "mine"}]


# --- graph assembly ---------------------------------------------------------

@responses.activate
def test_build_graph_wires_source_straight_to_destination(session):
    responses.add(
        responses.GET,
        f"{API_BASE}/sources",
        json=_list_page("sources", [{"id": "src_1", "slug": "web", "metadata": {"slug": "javascript"}}]),
    )
    responses.add(
        responses.GET,
        f"{API_BASE}/destinations",
        json=_list_page("destinations", [{"id": "dst_1", "name": "Braze", "metadata": {"slug": "braze"}}]),
    )
    responses.add(responses.GET, f"{API_BASE}/warehouses", json=_list_page("warehouses", []))
    responses.add(responses.GET, f"{API_BASE}/functions", json=_list_page("functions", []))
    responses.add(
        responses.GET,
        f"{API_BASE}/sources/src_1/connected-destinations",
        json=_list_page("destinations", [{"id": "dst_1"}]),
    )
    responses.add(
        responses.GET,
        f"{API_BASE}/sources/src_1/connected-warehouses",
        json=_list_page("warehouses", []),
    )
    responses.add(responses.GET, f"{API_BASE}/reverse-etl-models", json={}, status=404)
    responses.add(responses.GET, f"{API_BASE}/spaces", json={}, status=404)

    graph = resources.build_graph(session)

    ids = {node["id"] for node in graph["nodes"]}
    assert "source:src_1" in ids
    assert "destination:dst_1" in ids
    # No synthetic node stands between the two. Traffic used to be drawn as
    # source -> segment_core -> destination, on the argument that everything goes
    # through Segment; that claim is now made by the `segment` zone containing both
    # ends, which leaves the edge free to say the thing only it can say -- that a
    # human connected *this* source to *this* destination.
    assert not any(node["kind"] == "segment_core" for node in graph["nodes"])

    edges = {(e["source"], e["target"]) for e in graph["edges"]}
    assert ("source:src_1", "destination:dst_1") in edges


@responses.activate
def test_build_graph_deduplicates_a_connection_listed_twice(session):
    """
    One connection reported twice by the API is one edge.

    This test used to use two sources sharing a destination, which was a duplicate
    only while the hub collapsed both into `segment_core -> destination`. Those are
    now two distinct edges that must both survive -- see the test below -- so the
    duplicate has to come from where it can still come from: a paginated response
    listing the same connection on both pages.
    """
    responses.add(
        responses.GET,
        f"{API_BASE}/sources",
        json=_list_page("sources", [{"id": "src_1", "slug": "web", "metadata": {"slug": "javascript"}}]),
    )
    responses.add(
        responses.GET,
        f"{API_BASE}/destinations",
        json=_list_page("destinations", [{"id": "dst_1", "name": "Braze", "metadata": {"slug": "braze"}}]),
    )
    responses.add(responses.GET, f"{API_BASE}/warehouses", json=_list_page("warehouses", []))
    responses.add(responses.GET, f"{API_BASE}/functions", json=_list_page("functions", []))
    responses.add(
        responses.GET,
        f"{API_BASE}/sources/src_1/connected-destinations",
        json=_list_page("destinations", [{"id": "dst_1"}, {"id": "dst_1"}]),
    )
    responses.add(
        responses.GET,
        f"{API_BASE}/sources/src_1/connected-warehouses",
        json=_list_page("warehouses", []),
    )
    responses.add(responses.GET, f"{API_BASE}/reverse-etl-models", json={}, status=404)
    responses.add(responses.GET, f"{API_BASE}/spaces", json={}, status=404)

    graph = resources.build_graph(session)
    edge_ids = [e["id"] for e in graph["edges"]]
    assert edge_ids == ["source:src_1->destination:dst_1"]


@responses.activate
def test_build_graph_draws_one_edge_per_source_sharing_a_destination(session):
    """
    Two sources feeding one destination is two edges, not one.

    The hub made these indistinguishable, and that was the misleading part: two
    sources on one destination is two connections a customer configured separately
    and can misconfigure separately.
    """
    responses.add(
        responses.GET,
        f"{API_BASE}/sources",
        json=_list_page(
            "sources",
            [
                {"id": "src_1", "slug": "web", "metadata": {"slug": "javascript"}},
                {"id": "src_2", "slug": "ios", "metadata": {"slug": "ios"}},
            ],
        ),
    )
    responses.add(
        responses.GET,
        f"{API_BASE}/destinations",
        json=_list_page("destinations", [{"id": "dst_1", "name": "Braze", "metadata": {"slug": "braze"}}]),
    )
    responses.add(responses.GET, f"{API_BASE}/warehouses", json=_list_page("warehouses", []))
    responses.add(responses.GET, f"{API_BASE}/functions", json=_list_page("functions", []))
    for source_id in ("src_1", "src_2"):
        responses.add(
            responses.GET,
            f"{API_BASE}/sources/{source_id}/connected-destinations",
            json=_list_page("destinations", [{"id": "dst_1"}]),
        )
        responses.add(
            responses.GET,
            f"{API_BASE}/sources/{source_id}/connected-warehouses",
            json=_list_page("warehouses", []),
        )
    responses.add(responses.GET, f"{API_BASE}/reverse-etl-models", json={}, status=404)
    responses.add(responses.GET, f"{API_BASE}/spaces", json={}, status=404)

    graph = resources.build_graph(session)
    edges = {(e["source"], e["target"]) for e in graph["edges"]}
    assert edges == {
        ("source:src_1", "destination:dst_1"),
        ("source:src_2", "destination:dst_1"),
    }


@responses.activate
def test_build_graph_drops_edges_with_no_matching_node(session):
    """
    A connected-destination that is not in the destinations list (deleted between
    the two calls) must not leave a dangling edge for the canvas to swallow.
    """
    responses.add(
        responses.GET,
        f"{API_BASE}/sources",
        json=_list_page("sources", [{"id": "src_1", "slug": "web", "metadata": {"slug": "javascript"}}]),
    )
    responses.add(responses.GET, f"{API_BASE}/destinations", json=_list_page("destinations", []))
    responses.add(responses.GET, f"{API_BASE}/warehouses", json=_list_page("warehouses", []))
    responses.add(responses.GET, f"{API_BASE}/functions", json=_list_page("functions", []))
    responses.add(
        responses.GET,
        f"{API_BASE}/sources/src_1/connected-destinations",
        json=_list_page("destinations", [{"id": "dst_ghost"}]),
    )
    responses.add(
        responses.GET,
        f"{API_BASE}/sources/src_1/connected-warehouses",
        json=_list_page("warehouses", []),
    )
    responses.add(responses.GET, f"{API_BASE}/reverse-etl-models", json={}, status=404)
    responses.add(responses.GET, f"{API_BASE}/spaces", json={}, status=404)

    graph = resources.build_graph(session)
    targets = {e["target"] for e in graph["edges"]}
    assert "destination:dst_ghost" not in targets


@responses.activate
def test_a_workspace_without_unify_still_produces_a_graph(session):
    """Missing Unify is a shape of workspace, not an error."""
    responses.add(responses.GET, f"{API_BASE}/sources", json=_list_page("sources", []))
    responses.add(responses.GET, f"{API_BASE}/destinations", json=_list_page("destinations", []))
    responses.add(responses.GET, f"{API_BASE}/warehouses", json=_list_page("warehouses", []))
    responses.add(responses.GET, f"{API_BASE}/functions", json=_list_page("functions", []))
    responses.add(responses.GET, f"{API_BASE}/reverse-etl-models", json={}, status=404)
    responses.add(responses.GET, f"{API_BASE}/spaces", json={}, status=404)

    graph = resources.build_graph(session)
    assert graph["nodes"] == []
    assert graph["zones"]


@responses.activate
def test_palette_only_zones_are_not_shipped_with_a_workspace(session):
    """
    A workspace load must not materialise Sources/Destinations/Warehouse.

    They divide up Connections as a drawing choice, so putting them on the canvas
    unasked would give every customer three empty boxes to delete. The converse half --
    that they are still offered in the palette -- is asserted in test_topology.py,
    because it is `/api/meta/topology` and not this graph that the palette reads.
    """
    for path, key in (
        ("sources", "sources"),
        ("destinations", "destinations"),
        ("warehouses", "warehouses"),
        ("functions", "functions"),
    ):
        responses.add(responses.GET, f"{API_BASE}/{path}", json=_list_page(key, []))
    responses.add(responses.GET, f"{API_BASE}/reverse-etl-models", json={}, status=404)
    responses.add(responses.GET, f"{API_BASE}/spaces", json={}, status=404)

    shipped = {zone["id"] for zone in resources.build_graph(session)["zones"]}

    assert "connections" in shipped, "the product zones are still facts about a workspace"
    assert not shipped & set(topology.PALETTE_ONLY_ZONES)


# --- graph sanitization -----------------------------------------------------

def test_sanitize_strips_secret_shaped_keys():
    dirty = {
        "nodes": [
            {
                "id": "a",
                "data": {
                    "name": "Website",
                    "writeKey": "LIVE_WRITE_KEY",
                    "writeKeyMasked": "••••1234",
                    "settings": {"apiKey": "nested-secret", "token": "t"},
                },
            }
        ]
    }
    clean = sanitize_graph(dirty)
    flat = str(clean)

    assert "LIVE_WRITE_KEY" not in flat
    assert "nested-secret" not in flat
    # The masked display value survives -- it contains no usable secret.
    assert clean["nodes"][0]["data"]["writeKeyMasked"] == "••••1234"
    assert clean["nodes"][0]["data"]["name"] == "Website"


def test_saving_a_diagram_sanitizes_it(db):
    """
    Enforced at the model, not the serializer, so no future endpoint can persist a
    credential by forgetting to sanitize.
    """
    diagram = Diagram.objects.create(
        workspace_id=WORKSPACE["id"],
        name="Test",
        graph={"nodes": [{"data": {"writeKey": "LEAKED"}}]},
    )
    diagram.refresh_from_db()
    assert "LEAKED" not in str(diagram.graph)


def test_sanitize_leaves_ordinary_graphs_untouched():
    graph = {
        "nodes": [{"id": "a", "position": {"x": 1, "y": 2}, "data": {"kind": "source"}}],
        "edges": [{"id": "a->b", "source": "a", "target": "b"}],
        "viewport": {"x": 0, "y": 0, "zoom": 1},
    }
    assert sanitize_graph(graph) == graph


def test_sanitize_strips_a_secret_from_a_saved_scenario_event():
    """
    A walkthrough scenario carries an event payload someone typed by hand, so
    `properties.api_key` is a thing they can write -- and `graph.scenarios` is a part
    of the document neither validator looks at.

    Stripped rather than rejected, and not special-cased: sanitize_graph recurses
    every dict in the graph, which is precisely why a feature that added a new
    top-level key did not have to remember to opt into it.
    """
    graph = {
        "nodes": [{"id": "src", "data": {"kind": "source"}}],
        "edges": [],
        "scenarios": [
            {
                "id": "path:1",
                "name": "Orders",
                "sourceId": "src",
                "event": {
                    "type": "track",
                    "event": "Order Completed",
                    "properties": {"revenue": 42, "api_key": "sk_live_LEAKED"},
                },
            }
        ],
    }

    clean = sanitize_graph(graph)
    scenario = clean["scenarios"][0]

    assert "sk_live_LEAKED" not in str(clean)
    assert "api_key" not in scenario["event"]["properties"]
    # Everything else about the question the scenario asks survives intact.
    assert scenario["event"]["properties"]["revenue"] == 42
    assert scenario["name"] == "Orders"
    assert scenario["sourceId"] == "src"


def test_scenarios_survive_a_save_and_reload_through_the_api(auth_client):
    """
    `graph.scenarios` passes DRF untouched by design: validate_graph type-checks
    `nodes` and `edges`, and validate_architecture reads only those two.

    Pinned because "untouched" is the kind of claim that stops being true quietly --
    a stricter validate_graph that rejected unknown top-level keys would silently
    delete every saved walkthrough on the next save, and nothing else here would
    fail.
    """
    scenarios = [
        {
            "id": "path:1",
            "name": "With the insert function",
            "color": "#0263e0",
            "sourceId": "src",
            "event": {"type": "track", "event": "Order Completed"},
            "functionBehaviour": {"fn": "pass"},
            "disabled": [],
        },
        {
            "id": "path:2",
            "name": "Function off",
            "color": "#6f42c1",
            "sourceId": "src",
            "event": {"type": "track", "event": "Order Completed"},
            "functionBehaviour": {},
            "disabled": ["fn"],
        },
    ]
    graph = {
        "nodes": [
            {"id": "src", "kind": "source", "zone": "connections", "name": "Website"},
            {"id": "fn", "kind": "source_insert_function", "zone": "connections", "name": "Enrich"},
        ],
        "edges": [{"id": "e1", "source": "src", "target": "fn"}],
        "zones": [{"id": "connections", "label": "Connections", "order": 0}],
        "scenarios": scenarios,
    }

    created = auth_client.post("/api/diagrams", {"name": "Paths", "graph": graph}, format="json")
    assert created.status_code == 201

    reloaded = auth_client.get(f"/api/diagrams/{created.json()['id']}")
    assert reloaded.json()["graph"]["scenarios"] == scenarios
