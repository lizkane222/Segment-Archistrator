"""
The rules of a valid Segment architecture: component kinds, pipeline zones, and
which connections are legal.

This lives in Python and is served to the frontend at `/api/meta/topology` so
there is exactly one definition of the rules. Duplicating them in JS would
guarantee the two drift, and the canvas would start permitting diagrams the
backend considers invalid.
"""

from . import deeplinks

# --- Zones ------------------------------------------------------------------
# Zones nest, components do not. A zone may declare a `parent`; a component still
# stores exactly one `zone`, always the innermost one containing it. That asymmetry
# is deliberate -- "which zone is this component in?" has to have a single answer,
# because the stored `zone` field can only hold one.
ZONE_SEGMENT = "segment"
ZONE_CONNECTIONS = "connections"
ZONE_UNIFY = "unify"
ZONE_ENGAGE = "engage"

# Connections sub-zones
ZONE_PROTOCOLS = "protocols"
# Plural, and not for tidiness: the singular of each is already a component kind, and
# a zone id that collides with a kind id would make every id-keyed lookup in the
# project ambiguous to read even where it is not ambiguous to run.
ZONE_SOURCES = "sources"
ZONE_DESTINATIONS = "destinations"
ZONE_WAREHOUSES = "warehouses"

# Unify sub-zones
ZONE_PROFILE_SOURCES = "profile_sources"
ZONE_PROFILES = "profiles"
ZONE_IDENTITY_SETTINGS = "identity_settings"

# Engage sub-zones
ZONE_COMPUTATIONS = "computations"
ZONE_DEBUGGER = "debugger"
# Linked Audiences are their own region of Engage rather than more audiences in it. They are built by
# traversing warehouse entities through a Data Graph instead of from event and trait history, so
# nothing upstream of them is the same -- and a diagram that mixed the two would suggest an ordinary
# audience could reference an entity, which is the commonest misunderstanding of the feature.
ZONE_LINKED_AUDIENCES = "linked_audiences"

ZONES = [
    {
        "id": ZONE_SEGMENT,
        "label": "Segment",
        "description": (
            "Everything inside is Segment. Upstream of it is collection; downstream "
            "is delivery."
        ),
        "order": 0,
        "parent": None,
    },
    {
        "id": ZONE_CONNECTIONS,
        "label": "Connections",
        "description": "Sources, functions, filters, destinations, and warehouses.",
        "order": 0,
        "parent": ZONE_SEGMENT,
    },
    {
        "id": ZONE_PROTOCOLS,
        "label": "Protocols",
        "description": (
            "Tracking plans and the event and property libraries they draw from. "
            "What the data is supposed to look like, as opposed to what it is."
        ),
        "order": 0,
        # Inside Connections rather than beside it, because a tracking plan does
        # nothing on its own: it is enforced through a source's schema controls,
        # and the source is in Connections.
        "parent": ZONE_CONNECTIONS,
    },
    {
        "id": ZONE_SOURCES,
        "label": "Sources",
        "description": "Where data comes in, when the diagram wants them boxed off.",
        "order": 1,
        "parent": ZONE_CONNECTIONS,
        "subdivision": True,
    },
    {
        "id": ZONE_DESTINATIONS,
        "label": "Destinations",
        "description": "Where data goes out, when the diagram wants them boxed off.",
        "order": 2,
        "parent": ZONE_CONNECTIONS,
        "subdivision": True,
    },
    {
        "id": ZONE_WAREHOUSES,
        "label": "Warehouse",
        "description": "The warehouses Segment loads into, and the models read back out.",
        "order": 3,
        "parent": ZONE_CONNECTIONS,
        "subdivision": True,
    },
    {
        "id": ZONE_UNIFY,
        "label": "Unify",
        "description": "Spaces, identity resolution, computed traits, Profile API.",
        "order": 1,
        "parent": ZONE_SEGMENT,
    },
    {
        "id": ZONE_PROFILE_SOURCES,
        "label": "Profile Sources",
        "description": "The sources feeding profiles, and how identities are resolved.",
        "order": 0,
        "parent": ZONE_UNIFY,
        "subdivision": True,
    },
    {
        "id": ZONE_PROFILES,
        "label": "Profiles",
        "description": "Identifiers, traits, and events per profile.",
        "order": 1,
        "parent": ZONE_UNIFY,
        "subdivision": True,
    },
    {
        "id": ZONE_IDENTITY_SETTINGS,
        "label": "Identity Resolution Settings",
        "description": "Maintained by hand -- Segment publishes no API for these.",
        "order": 2,
        # Unify, not Engage. Identity resolution is what Unify *does*: the rules
        # decide which events collapse into one profile, and the space they are
        # configured on is a Unify space. It sat under Engage because that is where
        # the brief listed it, and the frontend has been drawing it in Unify's colours
        # with a comment saying exactly that (canvas/kinds.js) ever since -- two
        # answers to one question, which is what this removes.
        "parent": ZONE_UNIFY,
        "subdivision": True,
    },
    {
        "id": ZONE_ENGAGE,
        "label": "Engage",
        "description": "Audiences and journeys.",
        "order": 2,
        "parent": ZONE_SEGMENT,
    },
    {
        "id": ZONE_COMPUTATIONS,
        "label": "Computations",
        "description": "What Engage recomputes as profiles change.",
        "order": 0,
        "parent": ZONE_ENGAGE,
        "subdivision": True,
    },
    {
        "id": ZONE_DEBUGGER,
        "label": "Debugger",
        "description": "Events as they arrive. Populated by a walkthrough.",
        "order": 1,
        "parent": ZONE_ENGAGE,
        "subdivision": True,
    },
    {
        "id": ZONE_LINKED_AUDIENCES,
        "label": "Linked Audiences",
        "description": (
            "Audiences built by traversing warehouse entities, not event history."
        ),
        "order": 2,
        "parent": ZONE_ENGAGE,
        "subdivision": True,
    },
]

# Attached here rather than written inline above, so that every URL in the project
# still lives in deeplinks.py -- that file's whole purpose is being the one place to
# check a link against a real workspace.
for _zone in ZONES:
    _zone["docsUrl"] = deeplinks.zone_docs_url(_zone["id"])

ZONE_PARENT = {zone["id"]: zone.get("parent") for zone in ZONES}

# Which zones are a refinement of their parent rather than a place of their own.
#
# A subdivision is a drawing choice: Profiles is somewhere inside Unify to put profiles
# *if the diagram wants that box*, and a profile dropped on the bare Unify backdrop is
# filed correctly either way. Protocols is deliberately absent -- it is a product with
# its own docs, its own colour and three kinds that live nowhere else, so a tracking
# plan in bare Connections is a real misfiling and still says so.
#
# This is what `placement_zones` reads, and it is the only thing that distinguishes the
# two cases. Deriving it -- "a sub-zone that homes no kinds", say -- would have made
# Protocols a subdivision the day someone moved its kinds around.
ZONE_SUBDIVISION = {zone["id"]: bool(zone.get("subdivision")) for zone in ZONES}

# Zones a workspace fetch does not put on the canvas.
#
# Sources, Destinations and Warehouse divide up a Connections region that is already
# there, so they are a drawing choice rather than a fact about the workspace. Shipping
# them from `build_graph` would put three empty boxes inside Connections on every load,
# for every customer, whether or not that division was wanted -- and a zone is far more
# work to remove than to drag in. The product zones are the opposite: a Segment
# architecture has Connections and Unify whether or not anyone drew them.
#
# Still in ZONES, and so still in `/api/meta/topology`: the palette builds its
# draggable list from the full table, and being draggable is the entire point of these.
PALETTE_ONLY_ZONES = frozenset({ZONE_SOURCES, ZONE_DESTINATIONS, ZONE_WAREHOUSES})

DISCOVERED_ZONES = [zone for zone in ZONES if zone["id"] not in PALETTE_ONLY_ZONES]

# Zones that hold products rather than components.
#
# The Segment backdrop is a boundary, not a place a component is filed: what it says
# is "this is inside Segment", and which product owns the thing is a further question
# it deliberately does not answer. Several components have no answer to give -- Reverse
# ETL spans the line between the customer's warehouse and Segment's delivery, Profiles
# Sync takes profiles from Unify and audience membership from Engage -- so the backdrop
# is where they correctly go, and remarking on it was advice with nothing behind it.
#
# Read only by `placement_advisories`, and it is not the same statement as
# PALETTE_ONLY_ZONES: this is about a zone being a container, that one is about a zone
# being a drawing choice.
CONTAINER_ZONES = frozenset({ZONE_SEGMENT})


#: How a second copy of a zone on one canvas is named: `connections~2`.
#:
#: One canvas can hold several diagrams side by side, divided by a frame -- so the same
#: zone may appear more than once, and two zones sharing an id would collide in the
#: document (`zones` is keyed by id, and a component stores a single `zone` string). The
#: copy therefore gets its own id, and every rule here is about the *product*.
#:
#: The tilde is chosen for what it is not: `:` already separates the parts of
#: `custom:zone:ab12` and `manual:source:ab12`, and `-` appears inside product ids like
#: `profile_sources`. Mirrored by `zoneProductOf` in frontend/src/canvas/frames.js, which
#: is where the client-side half of this lives.
ZONE_INSTANCE_SEPARATOR = "~"


def zone_product(zone_id: str | None) -> str | None:
    """
    Which zone a possibly-duplicated id is a copy of. `connections~2` -> `connections`.

    The identity function for every zone that appears once, which is all of them until
    someone drops a second Connections beside the first.
    """
    if not zone_id:
        return zone_id
    head, separator, _ = zone_id.rpartition(ZONE_INSTANCE_SEPARATOR)
    return head if separator and head else zone_id


def zone_chain(zone_id: str | None) -> list[str]:
    """
    A zone and its ancestors, innermost first.

    Guards against a cycle rather than trusting the table: ZONES is hand-written,
    and a typo that made a zone its own ancestor would otherwise hang a request
    instead of failing a test.
    """
    chain: list[str] = []
    seen: set[str] = set()
    current = zone_id
    while current and current not in seen:
        seen.add(current)
        chain.append(current)
        current = ZONE_PARENT.get(current)
    return chain

# --- Component kinds --------------------------------------------------------
# `api` marks whether instances can be discovered from the Public API. Journeys
# cannot -- there is no Journeys API -- so they are authored by hand.
KINDS = {
    # Connections
    "source": {"label": "Source", "zone": ZONE_CONNECTIONS, "api": True},
    "source_function": {"label": "Source Function", "zone": ZONE_CONNECTIONS, "api": True},
    "source_insert_function": {
        "label": "Source Insert Function",
        "zone": ZONE_CONNECTIONS,
        "api": True,
    },
    "destination_filter": {
        "label": "Destination Filter",
        "zone": ZONE_CONNECTIONS,
        "api": True,
    },
    "destination_insert_function": {
        "label": "Destination Insert Function",
        "zone": ZONE_CONNECTIONS,
        "api": True,
    },
    "destination_function": {
        "label": "Destination Function",
        "zone": ZONE_CONNECTIONS,
        "api": True,
    },
    "destination_mapping": {
        "label": "Mapping",
        "zone": ZONE_CONNECTIONS,
        # /destinations/{id}/subscriptions -- an actions destination's mappings are
        # its subscriptions, which is the API's name for the same thing the UI calls
        # a mapping.
        "api": True,
        # A trigger (when the action fires) and a field mapping (what it sends), under
        # `data.trigger` and `data.fields`. Expandable internals for the same reason as
        # the Identity Resolver's buckets: nobody drops a component into a mapping.
        "expandable": True,
    },
    "destination": {"label": "Destination", "zone": ZONE_CONNECTIONS, "api": True},
    "source_schema_control": {
        "label": "Schema Controls",
        "zone": ZONE_CONNECTIONS,
        # /sources/{id}/settings
        "api": True,
    },
    "warehouse": {"label": "Warehouse", "zone": ZONE_CONNECTIONS, "api": True},
    "reverse_etl_model": {
        "label": "Reverse ETL Model",
        "zone": ZONE_CONNECTIONS,
        "api": True,
    },
    # Protocols
    "tracking_plan": {"label": "Tracking Plan", "zone": ZONE_PROTOCOLS, "api": True},
    # Both libraries are discoverable, because in the API they are not a separate
    # resource: /tracking-plans returns them as tracking plans carrying a library
    # `type`. Two kinds here rather than one with a flag, because they are two
    # different things on a diagram -- a group of events, and a group of properties
    # that events reuse.
    "event_library": {"label": "Event Library", "zone": ZONE_PROTOCOLS, "api": True},
    "property_library": {
        "label": "Property Library",
        "zone": ZONE_PROTOCOLS,
        "api": True,
    },
    # Unify
    "space": {"label": "Space", "zone": ZONE_UNIFY, "api": True},
    "identity_resolution": {
        "label": "Identity Resolution",
        "zone": ZONE_UNIFY,
        "api": False,
        "synthetic": True,
        # New / Append / Merge, under `data.buckets`. Rendered as expandable
        # internals rather than as three sub-zones: they are not regions you drop
        # components into, they are what this one component decided to do.
        "buckets": ["new", "append", "merge"],
    },
    "computed_trait": {"label": "Computed Trait", "zone": ZONE_UNIFY, "api": True},
    "profile_api": {
        "label": "Profile API",
        "zone": ZONE_UNIFY,
        "api": False,
        "synthetic": True,
    },
    "profile_sync": {
        "label": "Profiles Sync",
        # Unify, because that is where it is configured and what it reads -- even
        # though it also carries Engage's audience membership out with it, which is
        # why its edges come from both products.
        "zone": ZONE_UNIFY,
        # No endpoint listing a space's warehouse syncs has been confirmed, so this
        # is asserted by hand like profile_source and for the same reason.
        "api": False,
    },
    "profile_source": {
        "label": "Profile Source",
        "zone": ZONE_PROFILE_SOURCES,
        # There is a spaces API but no endpoint listing a space's profile sources,
        # so which sources feed profiles is asserted by hand.
        "api": False,
    },
    "profile": {
        "label": "Profile",
        "zone": ZONE_PROFILES,
        "api": False,
        # Identifiers, traits and events, under `data.identifiers`/`traits`/`events`.
        # A profile stands for a shape, not a person: putting a real profile in a
        # diagram that gets exported to PDF would put customer PII in a slide deck.
        "expandable": True,
    },
    # Engage
    "audience": {"label": "Audience", "zone": ZONE_ENGAGE, "api": True},
    # Built by walking entity relationships rather than by matching event history, which is why it is
    # its own kind and not a flag on `audience`: what may feed it, what it can be filtered on and
    # where it is configured are all different. `api: False` because the Public API does not list
    # them -- like a journey, these are transcribed by hand.
    "linked_audience": {
        "label": "Linked Audience",
        "zone": ZONE_LINKED_AUDIENCES,
        "api": False,
    },
    # No Journeys Public API: these are always hand-authored.
    "journey": {"label": "Journey", "zone": ZONE_ENGAGE, "api": False},
    # The entity model a Linked Audience traverses: which warehouse tables exist, and how they join.
    # Unify's, not Engage's, because it is part of how profiles are understood rather than part of
    # what is done with them -- and one Data Graph serves every Linked Audience in the space.
    "data_graph": {"label": "Data Graph", "zone": ZONE_UNIFY, "api": False},
    # A warehouse table as it appears in a diagram: columns, and a query someone ran to get them.
    # Deliberately zoned to Unify rather than to Connections' warehouses: what makes a table worth
    # drawing here is that a Data Graph or a Linked Audience refers to it.
    "sql_table": {"label": "SQL Table", "zone": ZONE_UNIFY, "api": False},
    "identity_setting": {
        "label": "Identity Resolution Rule",
        "zone": ZONE_IDENTITY_SETTINGS,
        "api": False,
    },
}

ZONE_FOR_KIND = {kind: spec["zone"] for kind, spec in KINDS.items()}

KINDS_BY_ZONE = {
    zone["id"]: [k for k, v in KINDS.items() if v["zone"] == zone["id"]] for zone in ZONES
}

# --- Legal connections ------------------------------------------------------
# Directed adjacency: ALLOWED_EDGES[from_kind] = set of legal to_kinds.
#
# There used to be a `segment_core` hub here, and every path ran through it:
# source -> segment_core -> destination, never source -> destination. It was
# replaced by the `segment` zone, which contains the pipeline rather than sitting
# in the middle of it -- the same claim ("everything goes through Segment") stated
# as containment instead of as an extra hop. What that costs is edge count: the hub
# collapsed N sources x M destinations into N+M edges, and these are the real
# connections, so a large workspace draws considerably more of them. That is the
# honest topology; canvas/grouping.js is what keeps it legible.
_POST_SEGMENT = {
    "destination_filter",
    "destination_insert_function",
    "destination_function",
    "destination_mapping",
    "destination",
    "warehouse",
    "space",
    # A profile source is a source *as a feeder of profiles*, so it takes an edge
    # from the source it stands for. Without one nothing could reach it and the
    # Profile Sources sub-zone would be unreachable from a walkthrough -- which is
    # the opposite of why it was asked for: whether a source is connected to the
    # space is a separate switch from the source existing, and the commonest reason
    # Unify sees nothing.
    "profile_source",
}

# Everything an event can reach *before* Segment has validated it. The one thing
# beyond the post-Segment set is the validation itself: schema controls are where
# an unplanned event is blocked or omitted, so they sit between a source and its
# fan-out. `source_schema_control` is absent from its own target set for the same
# reason -- an event is validated once, and control -> control would draw a second
# gate that does not exist.
_PRE_SEGMENT = {"source_schema_control", *_POST_SEGMENT}

ALLOWED_EDGES: dict[str, set[str]] = {
    # Includes itself: the same source is often drawn twice -- once in Connections,
    # once again in Unify's Profile Sources -- and an edge between the two copies is
    # how a diagram says "this is the same source" rather than two unrelated ones.
    #
    # Also reaches a profile directly, mirroring the reasoning on `profile`'s own
    # incoming edges below: what identity_resolution produces, a source drawn as a
    # Profile Source drives the same downstream when the diagram has no separate
    # identity_resolution node to draw the fan-out from.
    "source": {"source_insert_function", "source_function", "source", "profile", *_PRE_SEGMENT},
    "source_function": set(_PRE_SEGMENT),
    "source_insert_function": set(_PRE_SEGMENT),
    "source_schema_control": set(_POST_SEGMENT),
    "destination_filter": {"destination_insert_function", "destination_mapping", "destination"},
    "destination_insert_function": {"destination", "destination_function", "destination_mapping"},
    "destination_function": set(),  # terminal: it *is* the destination
    # A mapping is the last thing that touches the payload -- it is what turns the
    # event into this destination's own API call -- so it points at the delivery and
    # nothing else.
    "destination_mapping": {"destination", "destination_function"},
    # Not terminal after all: a destination's own mapping detail is drawn hanging off
    # it, and Profiles Sync's "audience membership from Engage" input is drawn from
    # the destination an audience activates rather than from the audience itself.
    "destination": {"destination_mapping", "profile_sync"},
    "warehouse": {"reverse_etl_model", "sql_table", "data_graph"},
    "reverse_etl_model": {"destination"},
    # A table feeds the entity model that describes it, and the audience that queries it. The arrow
    # runs from the table outward because that is the direction the *data* is read in -- a Linked
    # Audience pulls from the warehouse, it does not push.
    "sql_table": {"data_graph", "linked_audience"},
    # The entity model is what a Linked Audience traverses, so it points at them. It also feeds the
    # space: the Data Graph is part of how profiles are understood, not a thing beside them.
    "data_graph": {"linked_audience", "space"},
    # Terminal in the same sense a destination is: it is the thing being built, and what happens to
    # an audience afterwards -- a sync to a destination -- is drawn from the audience side.
    "linked_audience": {"destination", "destination_function"},
    # Not an event path: a plan is a definition, and the arrow says "this source is
    # connected to this plan, and its schema controls enforce it". Drawn in the
    # direction of enforcement rather than of data, because the alternative is a
    # tracking plan nothing on the diagram connects to.
    "tracking_plan": {"source", "source_schema_control"},
    "event_library": {"tracking_plan"},
    # Properties feed events as well as plans directly: a property library is what
    # several events in one plan reuse.
    "property_library": {"tracking_plan", "event_library"},
    "space": {
        "identity_resolution",
        "computed_trait",
        "audience",
        "profile_api",
        "profile_sync",
        # A space is where a Data Graph and its Linked Audiences are configured, so both are
        # reachable from it. Not the other way round for the audience: what a Linked Audience is
        # *built from* is the entity model, and drawing space -> linked_audience as the only path
        # would hide the Data Graph the feature depends on.
        "data_graph",
        "linked_audience",
    },
    "identity_resolution": {"computed_trait", "audience", "profile", "profile_sync"},
    # The debugger's source (a stand-in for "play a walkthrough and watch events
    # arrive here") for the same reason each of these already points at a journey or
    # an audience: a computed trait, an audience and a journey are all things a
    # walkthrough demonstrates by feeding events into the debugger.
    "computed_trait": {"audience", "journey", "profile_sync", "source"},
    "profile_api": set(),  # terminal: a read surface
    "profile_source": {"identity_resolution", "space"},
    # Not terminal: what identity_resolution produces, a profile drives the same
    # downstream as identity_resolution itself does when a diagram has no separate
    # identity_resolution node to draw the fan-out from.
    "profile": {"audience", "computed_trait", "journey"},
    # Out to a warehouse only. The edges *into* it are what the request means by
    # "Profile Sync connects to Unify and Engage": it takes profiles and traits from
    # Unify and audience membership from Engage, and lands both in one place.
    "profile_sync": {"warehouse"},
    "audience": {"journey", "destination", "profile_sync", "source"},
    "journey": {"audience", "destination", "source"},
    "identity_setting": set(),  # a documented rule, not a stage data passes through
}

# --- Before / after Segment's own processing ---------------------------------
# When a processing component runs, relative to Segment's collection and
# validation. This is what enforces "source functions run before Segment, insert
# functions and filters run after".
#
# Note this is a property of the *kind*, not of a position in the graph. It read
# as "which side of the segment_core node" while that node existed, but it never
# depended on it, and it survived the node's removal unchanged.
#
# Schema controls are the one processing kind with no entry, and the omission is the
# statement: they are neither before nor after Segment's own validation, they *are*
# it. Giving them a phase would put a third answer in a two-valued field.
EDGE_PHASE = {
    "source_function": "pre",
    "source_insert_function": "pre",
    "destination_filter": "post",
    "destination_insert_function": "post",
    "destination_mapping": "post",
    "destination_function": "post",
}


def is_valid_edge(from_kind: str, to_kind: str) -> bool:
    return to_kind in ALLOWED_EDGES.get(from_kind, set())


def placement_zones(kind: str) -> list[str]:
    """
    Every zone `kind` may be dropped straight into, innermost first.

    The kind's home, plus whatever that home merely subdivides. A profile source is
    homed in Profile Sources, which is a subdivision of Unify, so Unify itself takes
    one too -- and the ascent stops there, because Unify is not a subdivision of
    Segment. That stop is what keeps a component from landing in no product at all.
    """
    expected = ZONE_FOR_KIND.get(kind)
    if expected is None:
        return []

    zones = [expected]
    current = expected
    # Cycle-guarded via `zones`, matching zone_chain: the table is hand-written.
    while ZONE_SUBDIVISION.get(current):
        parent = ZONE_PARENT.get(current)
        if parent is None or parent in zones:
            break
        zones.append(parent)
        current = parent
    return zones


def is_valid_placement(kind: str, zone: str) -> bool:
    """
    May `kind` live in the zone `zone`?

    Two ways to be satisfied, and they are not the same rule read twice:

    Downward, by containment. The kind's home is the drop target or one of its
    ancestors -- a computed trait belongs in Unify, and Unify's Profiles sub-zone is
    still in Unify. Walking up from the target keeps this narrow in the direction that
    matters: a warehouse is not admitted to Unify just because both sit inside the
    Segment zone, because `connections` never appears in Unify's chain.

    Upward, and only as far as `placement_zones` allows. Dropping a profile on the
    Unify backdrop rather than inside the Profiles box was being reported as a
    misplacement, which is wrong twice over -- the sub-zone is optional, so the
    "correct" zone the warning named need not even be on the canvas.

    The two are checked separately rather than by ascending and then descending. A
    single combined chain would make a profile legal in Profile Sources, since both
    are inside Unify -- the sideways move, which neither rule permits and which is the
    one genuine misfiling among sibling subdivisions.
    """
    expected = ZONE_FOR_KIND.get(kind)
    if expected is None:
        return False
    # By product, so a component in the second copy of Connections on a divided canvas is
    # judged against Connections' rules rather than reported as being in a zone this table
    # has never heard of. Identical for every zone that appears once -- see `zone_product`.
    product = zone_product(zone)
    return expected in zone_chain(product) or product in placement_zones(kind)


def expected_zone(kind: str) -> str | None:
    return ZONE_FOR_KIND.get(kind)


def as_payload() -> dict:
    """Serializable form for `/api/meta/topology`, consumed by the canvas."""
    return {
        "zones": ZONES,
        "kinds": {
            kind: {
                **spec,
                "allowedTargets": sorted(ALLOWED_EDGES.get(kind, set())),
                "edgePhase": EDGE_PHASE.get(kind),
            }
            for kind, spec in KINDS.items()
        },
        "kindsByZone": KINDS_BY_ZONE,
    }
