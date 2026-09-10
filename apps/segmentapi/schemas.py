"""
Normalizers: raw Segment API payloads -> canonical node dicts for the canvas.

Every field access here is tolerant. Two independent reasons:

* Several surfaces are Alpha (Spaces, Space Schema, Computed Traits, Reverse ETL)
  and their shapes are explicitly subject to change.
* Real captured responses already disagree with the published samples. The
  audience capture in ../audience-list.json has `definition:{query,type}` plus
  `options:{...}` and prefixed ids (`aud_`, `spa_`), while the docs samples show
  bare 22-character ids and additional fields (`audienceType`, `size`,
  `computeCadence`). Both must parse.

Masking also happens here, so a normalized dict is safe to serialize by
construction rather than by a caller remembering to strip it.
"""

import re

from . import deeplinks, topology

# The eight Segment source types, used for icon and colour selection.
SOURCE_TYPES = (
    "javascript",
    "ios",
    "android",
    "server",
    "http",
    "react-native",
    "flutter",
    "unity",
)

# Journey-step membership is materialized as a computed trait named
# `j_o_<journey-slug>__<step-slug>_<hash>`. This is the only signal the API gives
# about journeys, since there is no Journeys endpoint.
JOURNEY_TRAIT_RE = re.compile(r"^j_o_(?P<journey>.+?)__(?P<step>.+?)_(?P<hash>[a-z0-9]{5,})$")


def mask_write_key(write_key: str | None) -> str | None:
    """
    Mask a write key for display, keeping the last 4 so it can be recognised.

    A write key lets anyone send events into the workspace, so it is masked
    everywhere by default. Revealing one goes through an explicit, audited
    endpoint.
    """
    if not write_key:
        return None
    tail = write_key[-4:] if len(write_key) > 4 else ""
    return "•" * 8 + tail


def _first(mapping: dict, *keys, default=None):
    """Return the first present, non-None key. Absorbs upstream field renames."""
    for key in keys:
        if isinstance(mapping, dict) and mapping.get(key) is not None:
            return mapping[key]
    return default


def _base_node(kind: str, *, resource_id: str, name: str, workspace_slug: str,
               slug: str | None = None, space_id: str | None = None,
               enabled: bool = True, description: str = "") -> dict:
    return {
        "id": f"{kind}:{resource_id}",
        "kind": kind,
        "zone": topology.expected_zone(kind),
        "name": name,
        "description": description or "",
        "slug": slug or "",
        "segmentId": resource_id,
        "enabled": bool(enabled),
        "bound": True,
        "docsUrl": deeplinks.docs_url(kind, slug=slug),
        "workspaceUrl": deeplinks.workspace_url(
            kind,
            workspace_slug=workspace_slug,
            slug=slug,
            resource_id=resource_id,
            space_id=space_id,
        ),
        "linkVerified": deeplinks.is_verified(kind),
    }


# --- Connections ------------------------------------------------------------

def normalize_source(raw: dict, *, workspace_slug: str) -> dict:
    source_id = _first(raw, "id", default="")
    slug = _first(raw, "slug", "name", default="")
    metadata = _first(raw, "metadata", default={}) or {}
    settings = _first(raw, "settings", default={}) or {}

    # Source type lives in metadata for real sources; fall back across the
    # variants that have been observed.
    source_type = (
        _first(metadata, "slug", default="")
        or _first(raw, "type", default="")
        or ""
    ).lower()

    node = _base_node(
        "source",
        resource_id=source_id,
        name=_first(raw, "name", "slug", default="Untitled source"),
        slug=slug,
        workspace_slug=workspace_slug,
        enabled=_first(raw, "enabled", default=True),
        description=_first(metadata, "description", default="") or "",
    )
    node.update(
        {
            "sourceType": source_type if source_type in SOURCE_TYPES else "http",
            "sourceTypeRaw": source_type,
            # Masked at the boundary: the raw key never enters a node dict.
            "writeKeyMasked": mask_write_key(_first(raw, "writeKey")),
            "isCloudSource": bool(_first(metadata, "isCloudEventSource", default=False)),
            "logoUrl": _first(metadata, "logos", default={}).get("default")
            if isinstance(_first(metadata, "logos"), dict)
            else None,
            "labels": _first(raw, "labels", default=[]) or [],
            "trackingPlanId": _first(settings, "trackingPlanId"),
        }
    )
    return node


def normalize_destination(raw: dict, *, workspace_slug: str) -> dict:
    dest_id = _first(raw, "id", default="")
    metadata = _first(raw, "metadata", default={}) or {}
    slug = _first(metadata, "slug", default="") or _first(raw, "name", default="")

    node = _base_node(
        "destination",
        resource_id=dest_id,
        name=_first(raw, "name", default="") or _first(metadata, "name", default="Untitled destination"),
        slug=slug,
        workspace_slug=workspace_slug,
        enabled=_first(raw, "enabled", default=True),
        description=_first(metadata, "description", default="") or "",
    )
    node.update(
        {
            "sourceId": _first(raw, "sourceId", default=""),
            "categories": _first(metadata, "categories", default=[]) or [],
            "logoUrl": _first(metadata, "logos", default={}).get("default")
            if isinstance(_first(metadata, "logos"), dict)
            else None,
            "metadataId": _first(metadata, "id", default=""),
        }
    )
    return node


def normalize_warehouse(raw: dict, *, workspace_slug: str) -> dict:
    wh_id = _first(raw, "id", default="")
    metadata = _first(raw, "metadata", default={}) or {}
    slug = _first(metadata, "slug", default="")
    node = _base_node(
        "warehouse",
        resource_id=wh_id,
        name=_first(metadata, "name", default="") or _first(raw, "name", default="Warehouse"),
        slug=slug,
        workspace_slug=workspace_slug,
        enabled=_first(raw, "enabled", default=True),
        description=_first(metadata, "description", default="") or "",
    )
    node["warehouseType"] = slug
    return node


def normalize_destination_filter(raw: dict, *, workspace_slug: str, destination_id: str) -> dict:
    filter_id = _first(raw, "id", default="")
    node = _base_node(
        "destination_filter",
        resource_id=filter_id,
        name=_first(raw, "title", "name", default="Filter"),
        workspace_slug=workspace_slug,
        enabled=_first(raw, "enabled", default=True),
        description=_first(raw, "description", default="") or "",
    )
    node.update(
        {
            "destinationId": destination_id,
            "sourceId": _first(raw, "sourceId", default=""),
            # The filter condition (FQL) and actions drive the simulator's
            # drop/pass decision.
            "condition": _first(raw, "if", "condition", default=""),
            "actions": _first(raw, "actions", default=[]) or [],
        }
    )
    return node


def normalize_function(raw: dict, *, workspace_slug: str) -> dict:
    """
    A function's kind depends on its resourceType.

    SOURCE -> source_function, DESTINATION -> destination_function,
    INSERT_DESTINATION -> destination_insert_function.
    """
    resource_type = (_first(raw, "resourceType", default="") or "").upper()
    kind = {
        "SOURCE": "source_function",
        "DESTINATION": "destination_function",
        "INSERT_DESTINATION": "destination_insert_function",
    }.get(resource_type, "destination_function")

    fn_id = _first(raw, "id", default="")
    node = _base_node(
        kind,
        resource_id=fn_id,
        name=_first(raw, "displayName", "name", default="Function"),
        workspace_slug=workspace_slug,
        description=_first(raw, "description", default="") or "",
    )
    node.update(
        {
            "resourceType": resource_type,
            "logoUrl": _first(raw, "logoUrl"),
            "deployedAt": _first(raw, "deployedAt"),
            "previewWebhookUrl": _first(raw, "previewWebhookUrl"),
        }
    )
    return node


def normalize_reverse_etl_model(raw: dict, *, workspace_slug: str) -> dict:
    model_id = _first(raw, "id", default="")
    node = _base_node(
        "reverse_etl_model",
        resource_id=model_id,
        name=_first(raw, "name", default="Reverse ETL model"),
        workspace_slug=workspace_slug,
        enabled=_first(raw, "enabled", default=True),
        description=_first(raw, "description", default="") or "",
    )
    node.update(
        {
            "sourceId": _first(raw, "sourceId", default=""),
            "query": _first(raw, "query", default=""),
            "scheduleStrategy": _first(raw, "scheduleStrategy", default=""),
        }
    )
    return node


# --- Unify / Engage ---------------------------------------------------------

def normalize_space(raw: dict, *, workspace_slug: str) -> dict:
    space_id = _first(raw, "id", default="")
    node = _base_node(
        "space",
        resource_id=space_id,
        name=_first(raw, "name", default="Space"),
        slug=_first(raw, "slug", default=""),
        workspace_slug=workspace_slug,
        space_id=space_id,
    )
    return node


def normalize_computed_trait(raw: dict, *, workspace_slug: str, space_id: str) -> dict:
    trait_id = _first(raw, "id", default="")
    definition = _first(raw, "definition", default={}) or {}
    node = _base_node(
        "computed_trait",
        resource_id=trait_id,
        name=_first(raw, "name", default="Computed trait"),
        slug=_first(raw, "key", default=""),
        workspace_slug=workspace_slug,
        space_id=space_id,
        enabled=_first(raw, "enabled", default=True),
        description=_first(raw, "description", default="") or "",
    )
    node.update(
        {
            "spaceId": space_id,
            "traitKey": _first(raw, "key", default=""),
            "query": _first(definition, "query", default=""),
            "definitionType": _first(definition, "type", default=""),
            "computeCadence": _first(raw, "computeCadence", default=""),
            # A journey step masquerading as a trait -- see JOURNEY_TRAIT_RE.
            "isJourneyStep": bool(JOURNEY_TRAIT_RE.match(_first(raw, "key", default="") or "")),
        }
    )
    return node


def normalize_audience(raw: dict, *, workspace_slug: str, space_id: str) -> dict:
    """
    Tolerant across both observed shapes.

    Real capture: {definition: {query, type}, options: {...}, status: "Live"}.
    Docs sample adds audienceType / size / computeCadence. Neither is guaranteed.
    """
    audience_id = _first(raw, "id", default="")
    definition = _first(raw, "definition", default={}) or {}
    options = _first(raw, "options", default={}) or {}

    node = _base_node(
        "audience",
        resource_id=audience_id,
        name=_first(raw, "name", default="Audience"),
        slug=_first(raw, "key", default=""),
        workspace_slug=workspace_slug,
        space_id=_first(raw, "spaceId", default=space_id),
        enabled=_first(raw, "enabled", default=True),
        description=_first(raw, "description", default="") or "",
    )
    node.update(
        {
            "spaceId": _first(raw, "spaceId", default=space_id),
            "audienceKey": _first(raw, "key", default=""),
            "query": _first(definition, "query", default=""),
            "definitionType": _first(definition, "type", default="USERS"),
            "status": _first(raw, "status", default=""),
            "audienceType": _first(raw, "audienceType", default=""),
            "size": _first(raw, "size"),
            "includeAnonymousUsers": _first(options, "includeAnonymousUsers", default=False),
            "includeHistoricalData": _first(options, "includeHistoricalData", default=False),
        }
    )
    return node


# --- Journeys: inference only ------------------------------------------------

def infer_journeys_from_traits(traits: list[dict]) -> list[dict]:
    """
    Best-effort journey reconstruction from computed-trait names.

    There is no Journeys Public API. Segment does materialize journey-step
    membership as a computed trait named `j_o_<journey>__<step>_<hash>`, so the
    set of journeys and their steps can be *guessed* from trait keys.

    This is a hint for pre-populating the canvas, not a source of truth: step
    ordering is not recoverable, and a renamed journey leaves the old trait key
    behind. Everything returned is flagged `inferred: True` so the UI can say so.
    """
    journeys: dict[str, dict] = {}
    for trait in traits:
        key = trait.get("key") or trait.get("traitKey") or ""
        match = JOURNEY_TRAIT_RE.match(key)
        if not match:
            continue
        journey_slug = match.group("journey")
        step_slug = match.group("step")
        journey = journeys.setdefault(
            journey_slug,
            {
                "slug": journey_slug,
                "name": journey_slug.replace("_", " ").strip().title(),
                "steps": [],
                "inferred": True,
            },
        )
        journey["steps"].append(
            {
                "slug": step_slug,
                "name": step_slug.replace("_", " ").strip().title(),
                "traitKey": key,
                # Ordering is not recoverable from the naming convention.
                "orderKnown": False,
            }
        )
    return sorted(journeys.values(), key=lambda j: j["slug"])


# --- Catalog ----------------------------------------------------------------

def normalize_catalog_entry(raw: dict, kind: str) -> dict:
    """Flatten a catalog entry into CatalogComponent field values."""
    logos = _first(raw, "logos", default={}) or {}
    return {
        "kind": kind,
        "metadata_id": _first(raw, "id", default=""),
        "slug": (_first(raw, "slug", default="") or "")[:255],
        "name": (_first(raw, "name", default="") or "")[:255],
        "description": _first(raw, "description", default="") or "",
        "categories": _first(raw, "categories", default=[]) or [],
        "logo_url": (logos.get("default") or logos.get("mark") or "")[:1024]
        if isinstance(logos, dict)
        else "",
        "docs_url": deeplinks.docs_url(kind, slug=_first(raw, "slug")) or "",
        "raw": raw,
    }
