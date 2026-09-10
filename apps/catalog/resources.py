"""
The read-through cache over a customer's live workspace, and the graph assembler.

Every workspace resource the frontend asks for goes through `fetch()`, so the
TTL and the `?refresh=1` bypass are defined once. This matters more than it
sounds: computed traits and the entire Space Schema surface allow only 25
requests per minute, and a single canvas render can easily want more than that.

`build_graph()` is the auto-generate call. It fans out over sources to discover
edges, which is the only way to get them -- the API exposes connections as
`/sources/{id}/connected-destinations` and `-warehouses`, not as a graph.
"""

import logging
from concurrent.futures import ThreadPoolExecutor

from django.conf import settings

from apps.segmentapi import schemas, topology
from apps.segmentapi.client import SegmentClient
from apps.segmentapi.exceptions import SegmentFeatureUnavailable, SegmentRateLimited

from .models import WorkspaceResourceCache

logger = logging.getLogger(__name__)

# Sources are fanned out concurrently, but modestly. Each source costs two
# requests, so a workspace with 50 sources is 100 requests; going wide here is
# the fastest way to trip a rate limit.
FANOUT_WORKERS = 4


def fetch(session, resource_type: str, loader, *, ttl: int | None = None, refresh: bool = False):
    """
    Read `resource_type` for a workspace, from cache when fresh.

    `loader` is called with a SegmentClient only on a miss. A
    SegmentFeatureUnavailable is cached as an empty result: if the workspace does
    not have Reverse ETL, asking again in 30 seconds will not change that, and
    the UI should just render without those nodes.
    """
    workspace_id = session.workspace_id
    if not refresh:
        cached = WorkspaceResourceCache.get_fresh(workspace_id, resource_type)
        if cached is not None:
            return cached

    client = SegmentClient.for_session(session)
    try:
        payload = loader(client)
    except SegmentFeatureUnavailable:
        logger.info(
            "Workspace %s does not have the feature behind %s; treating as empty.",
            workspace_id,
            resource_type,
        )
        payload = []

    WorkspaceResourceCache.put(
        workspace_id,
        resource_type,
        payload,
        ttl if ttl is not None else settings.WORKSPACE_CACHE_TTL,
    )
    return payload


# --- Per-resource loaders ---------------------------------------------------
# Each returns already-normalized node dicts, so nothing downstream ever touches
# a raw Segment payload -- and write keys are masked before they leave the client.

def get_sources(session, *, refresh=False):
    def load(client):
        return [
            schemas.normalize_source(raw, workspace_slug=session.workspace_slug)
            for raw in client.list_sources()
        ]

    return fetch(session, "sources", load, refresh=refresh)


def get_destinations(session, *, refresh=False):
    def load(client):
        return [
            schemas.normalize_destination(raw, workspace_slug=session.workspace_slug)
            for raw in client.list_destinations()
        ]

    return fetch(session, "destinations", load, refresh=refresh)


def get_warehouses(session, *, refresh=False):
    def load(client):
        return [
            schemas.normalize_warehouse(raw, workspace_slug=session.workspace_slug)
            for raw in client.list_warehouses()
        ]

    return fetch(session, "warehouses", load, refresh=refresh)


def get_functions(session, *, refresh=False):
    def load(client):
        nodes = []
        for resource_type in ("SOURCE", "DESTINATION", "INSERT_DESTINATION"):
            try:
                raws = client.list_functions(resource_type)
            except SegmentFeatureUnavailable:
                continue
            nodes.extend(
                schemas.normalize_function(raw, workspace_slug=session.workspace_slug)
                for raw in raws
            )
        return nodes

    return fetch(session, "functions", load, refresh=refresh)


def get_reverse_etl_models(session, *, refresh=False):
    def load(client):
        return [
            schemas.normalize_reverse_etl_model(raw, workspace_slug=session.workspace_slug)
            for raw in client.list_reverse_etl_models()
        ]

    return fetch(session, "reverse_etl_models", load, refresh=refresh)


def get_spaces(session, *, refresh=False):
    def load(client):
        return [
            schemas.normalize_space(raw, workspace_slug=session.workspace_slug)
            for raw in client.list_spaces()
        ]

    return fetch(session, "spaces", load, refresh=refresh)


def get_audiences(session, space_id, *, refresh=False):
    def load(client):
        return [
            schemas.normalize_audience(
                raw, workspace_slug=session.workspace_slug, space_id=space_id
            )
            for raw in client.list_audiences(space_id)
        ]

    return fetch(session, f"audiences:{space_id}", load, refresh=refresh)


def get_computed_traits(session, space_id, *, refresh=False):
    def load(client):
        return [
            schemas.normalize_computed_trait(
                raw, workspace_slug=session.workspace_slug, space_id=space_id
            )
            for raw in client.list_computed_traits(space_id)
        ]

    return fetch(session, f"computed_traits:{space_id}", load, refresh=refresh)


def get_destination_filters(session, destination_id, *, refresh=False):
    def load(client):
        return [
            schemas.normalize_destination_filter(
                raw,
                workspace_slug=session.workspace_slug,
                destination_id=destination_id,
            )
            for raw in client.list_destination_filters(destination_id)
        ]

    return fetch(session, f"destination_filters:{destination_id}", load, refresh=refresh)


# --- Space Schema -----------------------------------------------------------
# Longer TTL: 25 req/min, and schemas change on the order of days, not seconds.

def get_space_events(session, space_id, *, refresh=False):
    def load(client):
        return client.list_space_events(space_id)

    return fetch(
        session,
        f"space_events:{space_id}",
        load,
        ttl=settings.SPACE_SCHEMA_CACHE_TTL,
        refresh=refresh,
    )


def get_space_event_properties(session, space_id, event_name, *, refresh=False):
    def load(client):
        return client.list_space_event_properties(space_id, event_name)

    return fetch(
        session,
        f"space_event_props:{space_id}:{event_name}",
        load,
        ttl=settings.SPACE_SCHEMA_CACHE_TTL,
        refresh=refresh,
    )


def get_space_traits(session, space_id, *, refresh=False):
    def load(client):
        return client.list_space_traits(space_id)

    return fetch(
        session,
        f"space_traits:{space_id}",
        load,
        ttl=settings.SPACE_SCHEMA_CACHE_TTL,
        refresh=refresh,
    )


# --- Graph assembly ---------------------------------------------------------


def _edge(source: str, target: str, *, kind: str = "flow") -> dict:
    return {"id": f"{source}->{target}", "source": source, "target": target, "kind": kind}


def _connections_for_source(session, source_node) -> tuple[list[dict], list[str]]:
    """
    One source's outgoing connections.

    Returns (edges, warnings). Runs in a worker thread, so it builds its own
    client rather than sharing one -- requests.Session is not thread-safe for
    concurrent use in the general case.

    Every edge starts at the source itself. A `segment_core:core` hub used to stand
    in the middle, which made this cheap -- one edge in, one edge per connection out,
    shared across all sources. Drawing the real connections means a destination
    connected to twenty sources gets twenty edges, because that is twenty things a
    customer configured and can misconfigure independently.
    """
    client = SegmentClient.for_session(session)
    source_id = source_node["segmentId"]
    node_id = f"source:{source_id}"
    edges: list[dict] = []
    warnings: list[str] = []

    try:
        for dest in client.list_connected_destinations(source_id):
            dest_id = dest.get("id")
            if dest_id:
                edges.append(_edge(node_id, f"destination:{dest_id}"))
    except SegmentRateLimited as exc:
        warnings.append(
            f"Rate limited while reading destinations for '{source_node['name']}'. "
            f"Some connections may be missing. {exc.detail}"
        )
    except SegmentFeatureUnavailable:
        pass

    try:
        for warehouse in client.list_connected_warehouses(source_id):
            wh_id = warehouse.get("id")
            if wh_id:
                edges.append(_edge(node_id, f"warehouse:{wh_id}"))
    except SegmentRateLimited as exc:
        warnings.append(
            f"Rate limited while reading warehouses for '{source_node['name']}'. "
            f"Some connections may be missing. {exc.detail}"
        )
    except SegmentFeatureUnavailable:
        pass

    return edges, warnings


def build_graph(session, *, refresh: bool = False) -> dict:
    """
    Assemble the whole workspace as `{nodes, edges, zones, warnings}`.

    Every node is already tagged with its pipeline zone, so the canvas can place
    it without consulting the rule table a second time.

    Partial failure is normal and expected here: a workspace may not have Unify,
    or a fan-out may hit a rate limit halfway through. Anything missing is
    reported in `warnings` rather than failing the whole request -- a diagram
    with a caveat beats an error page.
    """
    warnings: list[str] = []
    inferred_journeys: list[dict] = []

    sources = get_sources(session, refresh=refresh)
    destinations = get_destinations(session, refresh=refresh)
    warehouses = get_warehouses(session, refresh=refresh)
    functions = get_functions(session, refresh=refresh)

    nodes: list[dict] = []
    nodes.extend(sources)
    nodes.extend(destinations)
    nodes.extend(warehouses)
    nodes.extend(functions)

    edges: list[dict] = []
    if sources:
        with ThreadPoolExecutor(max_workers=FANOUT_WORKERS) as pool:
            for source_edges, source_warnings in pool.map(
                lambda node: _connections_for_source(session, node), sources
            ):
                edges.extend(source_edges)
                warnings.extend(source_warnings)

    # Reverse ETL: warehouse -> model -> destination.
    for model in get_reverse_etl_models(session, refresh=refresh):
        nodes.append(model)
        if model.get("sourceId"):
            edges.append(_edge(f"warehouse:{model['sourceId']}", model["id"]))

    # Unify / Engage. Spaces are absent on workspaces without Unify, in which
    # case get_spaces returns [] and this whole block is a no-op.
    spaces = get_spaces(session, refresh=refresh)
    nodes.extend(spaces)
    if spaces and sources:
        # No edges into the space, deliberately. The old hub gave us one honest
        # `segment_core -> space` edge for free; without it the truthful statement is
        # "these particular sources feed this space", and Segment publishes no
        # endpoint listing a space's profile sources. Connecting every source to
        # every space instead would draw a confident line for a fact we do not have.
        # Flagged the same way inferred journeys are, and Unify's Profile Sources
        # sub-zone is where the user asserts it.
        warnings.append(
            f"Which of the {len(sources)} source(s) feed profiles is not readable from "
            "the Public API. Add Profile Sources in Unify to record it."
        )
    for space in spaces:
        space_id = space["segmentId"]

        traits = get_computed_traits(session, space_id, refresh=refresh)
        nodes.extend(traits)
        for trait in traits:
            edges.append(_edge(space["id"], trait["id"]))

        audiences = get_audiences(session, space_id, refresh=refresh)
        nodes.extend(audiences)
        for audience in audiences:
            edges.append(_edge(space["id"], audience["id"]))

        # Journeys cannot be listed -- there is no Journeys API. Inferred from
        # the j_o_* computed-trait naming convention and flagged as such, so the
        # canvas can offer to create them rather than pretending it found them.
        inferred = schemas.infer_journeys_from_traits(traits)
        if inferred:
            for journey in inferred:
                journey["spaceId"] = space_id
            inferred_journeys.extend(inferred)
            warnings.append(
                f"{len(inferred)} journey(s) inferred from computed-trait names in "
                f"'{space['name']}'. Segment has no Journeys API, so these are a "
                "best guess -- step order is unknown."
            )

    # Deduplicate. This used to absorb the hub's fan-in -- five sources sharing a
    # destination produced five identical `segment_core -> destination` edges. Those
    # are now five *distinct* edges and all of them are kept, so what is left to
    # guard is an upstream response listing the same connection twice, which React
    # Flow would render as duplicate ids.
    seen: set[str] = set()
    unique_edges = []
    for edge in edges:
        if edge["id"] in seen:
            continue
        seen.add(edge["id"])
        unique_edges.append(edge)

    # Drop edges pointing at nodes that were never fetched, rather than shipping
    # dangling references the canvas would silently discard.
    node_ids = {node["id"] for node in nodes}
    dangling = [e for e in unique_edges if e["source"] not in node_ids or e["target"] not in node_ids]
    if dangling:
        logger.info("Dropping %s edge(s) with no matching node.", len(dangling))
        unique_edges = [e for e in unique_edges if e not in dangling]

    return {
        "nodes": nodes,
        "edges": unique_edges,
        "zones": topology.DISCOVERED_ZONES,
        "warnings": warnings,
        "inferredJourneys": inferred_journeys,
    }
