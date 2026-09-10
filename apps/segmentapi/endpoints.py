"""
Every Segment Public API path this app uses, in one place.

All paths were checked against docs.segmentapis.com during design. Two facts
that are easy to get wrong and worth stating up front:

* The base URL has **no** `/v1` prefix. Paths are bare: `GET /sources`.
  Versioning is negotiated with the Accept header instead.
* Destination *filters* live under `/destination/{id}/filters` -- **singular**
  `destination` -- unlike every other path in the API, which uses the plural.
  This is not a typo below.

`ACCEPT_*` values matter: several surfaces (Spaces, Space Schema, Computed
Traits, Reverse ETL, insert-function instances) are Alpha and 404 or 406 if
asked for with the v1 media type.
"""

from dataclasses import dataclass

# --- Accept headers ---------------------------------------------------------
ACCEPT_V1 = "application/vnd.segment.v1+json"
ACCEPT_V1BETA = "application/vnd.segment.v1beta+json"
ACCEPT_V1ALPHA = "application/vnd.segment.v1alpha+json"


@dataclass(frozen=True)
class Endpoint:
    """
    A single Public API operation.

    pagination_required: some endpoints return 422 when the pagination params are
    absent (`/catalog/destinations`, the two source connected-* endpoints), so
    the client always sends them rather than tracking which ones insist.
    """

    path: str
    accept: str = ACCEPT_V1
    paginated: bool = False
    pagination_required: bool = False
    # Per-endpoint documented rate limit, requests/minute. None = workspace default.
    rate_limit_per_min: int | None = None
    # Feature that must be enabled on the workspace; a 404 here means "not
    # enabled" far more often than "wrong path", which the client uses to raise
    # SegmentFeatureUnavailable instead of SegmentNotFound.
    requires_feature: str | None = None

    def format(self, **kwargs) -> str:
        return self.path.format(**kwargs)


# --- Identity ---------------------------------------------------------------
# GET / -> {"data": {"workspace": {"id", "name", "slug"}}}
# This is both the token-validation call and the workspace-derivation call.
GET_WORKSPACE = Endpoint("/")

# --- Connections: sources ---------------------------------------------------
LIST_SOURCES = Endpoint("/sources", paginated=True)
GET_SOURCE = Endpoint("/sources/{source_id}")
LIST_SOURCE_CONNECTED_DESTINATIONS = Endpoint(
    "/sources/{source_id}/connected-destinations",
    paginated=True,
    pagination_required=True,
)
LIST_SOURCE_CONNECTED_WAREHOUSES = Endpoint(
    "/sources/{source_id}/connected-warehouses",
    paginated=True,
    pagination_required=True,
)
LIST_SOURCE_SCHEMA_SETTINGS = Endpoint("/sources/{source_id}/settings")

# --- Connections: destinations ----------------------------------------------
LIST_DESTINATIONS = Endpoint("/destinations", paginated=True)
GET_DESTINATION = Endpoint("/destinations/{destination_id}")
LIST_DESTINATION_SUBSCRIPTIONS = Endpoint(
    "/destinations/{destination_id}/subscriptions",
    accept=ACCEPT_V1ALPHA,
    paginated=True,
    requires_feature="destination-subscriptions",
)
LIST_DESTINATION_DELIVERY_METRICS = Endpoint(
    "/destinations/{destination_id}/delivery-metrics"
)

# --- Connections: destination filters ---------------------------------------
# NOTE the singular "/destination/" segment. Verified; not a typo.
LIST_DESTINATION_FILTERS = Endpoint(
    "/destination/{destination_id}/filters", paginated=True
)
GET_DESTINATION_FILTER = Endpoint("/destination/{destination_id}/filters/{filter_id}")

# --- Connections: warehouses ------------------------------------------------
LIST_WAREHOUSES = Endpoint("/warehouses", paginated=True)
GET_WAREHOUSE = Endpoint("/warehouses/{warehouse_id}")
LIST_WAREHOUSE_CONNECTED_SOURCES = Endpoint(
    "/warehouses/{warehouse_id}/connected-sources", paginated=True
)

# --- Connections: functions -------------------------------------------------
# `resourceType` is REQUIRED on list. Valid values below.
LIST_FUNCTIONS = Endpoint("/functions", paginated=True, requires_feature="functions")
GET_FUNCTION = Endpoint("/functions/{function_id}", requires_feature="functions")
FUNCTION_RESOURCE_TYPES = ("SOURCE", "DESTINATION", "INSERT_DESTINATION")

LIST_INSERT_FUNCTION_INSTANCES = Endpoint(
    "/insert-function-instances",
    accept=ACCEPT_V1ALPHA,
    paginated=True,
    requires_feature="functions",
)

# --- Connections: Reverse ETL -----------------------------------------------
LIST_REVERSE_ETL_MODELS = Endpoint(
    "/reverse-etl-models",
    accept=ACCEPT_V1ALPHA,
    paginated=True,
    requires_feature="reverse-etl",
)
GET_REVERSE_ETL_MODEL = Endpoint(
    "/reverse-etl-models/{model_id}",
    accept=ACCEPT_V1ALPHA,
    requires_feature="reverse-etl",
)

# --- Catalog (global, workspace-independent) --------------------------------
# /catalog/destinations 422s without pagination params.
CATALOG_SOURCES = Endpoint("/catalog/sources", paginated=True)
CATALOG_DESTINATIONS = Endpoint(
    "/catalog/destinations", paginated=True, pagination_required=True
)
CATALOG_WAREHOUSES = Endpoint("/catalog/warehouses", paginated=True)

# --- Unify: spaces ----------------------------------------------------------
LIST_SPACES = Endpoint(
    "/spaces", accept=ACCEPT_V1ALPHA, paginated=True, requires_feature="spaces"
)
GET_SPACE = Endpoint(
    "/spaces/{space_id}", accept=ACCEPT_V1ALPHA, requires_feature="spaces"
)

# --- Unify: computed traits (Private Beta) ----------------------------------
LIST_COMPUTED_TRAITS = Endpoint(
    "/spaces/{space_id}/computed-traits",
    accept=ACCEPT_V1ALPHA,
    paginated=True,
    rate_limit_per_min=25,
    requires_feature="computed-traits",
)
GET_COMPUTED_TRAIT = Endpoint(
    "/spaces/{space_id}/computed-traits/{trait_id}",
    accept=ACCEPT_V1ALPHA,
    rate_limit_per_min=100,
    requires_feature="computed-traits",
)

# --- Unify: Space Schema API (Alpha, 25 req/min across the board) -----------
# This is what powers the inspector's "available fields / nested data" panel and
# seeds the event simulator with real property names and sample values.
LIST_SPACE_EVENTS = Endpoint(
    "/spaces/{space_id}/events",
    accept=ACCEPT_V1ALPHA,
    paginated=True,
    rate_limit_per_min=25,
    requires_feature="space-schema",
)
LIST_SPACE_EVENT_PROPERTIES = Endpoint(
    "/spaces/{space_id}/events/{event_name}/properties",
    accept=ACCEPT_V1ALPHA,
    paginated=True,
    rate_limit_per_min=25,
    requires_feature="space-schema",
)
LIST_SPACE_TRAITS = Endpoint(
    "/spaces/{space_id}/traits",
    accept=ACCEPT_V1ALPHA,
    paginated=True,
    rate_limit_per_min=25,
    requires_feature="space-schema",
)
LIST_SPACE_ENTITY_PATHS = Endpoint(
    "/spaces/{space_id}/entity-paths",
    accept=ACCEPT_V1ALPHA,
    paginated=True,
    rate_limit_per_min=25,
    requires_feature="space-schema",
)
# propertyType is REQUIRED here and must be "CONTEXT" or "PROPERTY".
LIST_SPACE_EVENT_PROPERTY_SAMPLES = Endpoint(
    "/spaces/{space_id}/events/{event_name}/properties/{property_name}/sample-values",
    accept=ACCEPT_V1ALPHA,
    paginated=True,
    rate_limit_per_min=25,
    requires_feature="space-schema",
)
PROPERTY_TYPES = ("CONTEXT", "PROPERTY")

# --- Engage: audiences ------------------------------------------------------
LIST_AUDIENCES = Endpoint(
    "/spaces/{space_id}/audiences",
    paginated=True,
    rate_limit_per_min=60,
    requires_feature="audiences",
)
GET_AUDIENCE = Endpoint(
    "/spaces/{space_id}/audiences/{audience_id}",
    rate_limit_per_min=100,
    requires_feature="audiences",
)

# --- Protocols --------------------------------------------------------------
LIST_TRACKING_PLANS = Endpoint("/tracking-plans", paginated=True)
LIST_TRACKING_PLAN_RULES = Endpoint(
    "/tracking-plans/{tracking_plan_id}/rules",
    paginated=True,
    rate_limit_per_min=200,
)

# ---------------------------------------------------------------------------
# Journeys: intentionally absent.
#
# There is no Journeys surface in the Public API -- it is not in the tag list.
# Journey nodes are authored by hand on the canvas. A partial heuristic exists:
# Segment materializes journey-step membership as computed traits named
# `j_o_<journey>__<step>_<hash>`, so LIST_COMPUTED_TRAITS can *hint* at journey
# structure. See apps/segmentapi/schemas.py:infer_journeys_from_traits.
# Treat it as a hint, never as authoritative.
# ---------------------------------------------------------------------------
