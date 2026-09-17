"""
The architecture rules.

These are cheap to test and expensive to get wrong: the canvas refuses drops and
connections based entirely on this table, so a missing entry silently makes a
legitimate architecture undrawable.
"""

import re
from pathlib import Path

import pytest

from apps.segmentapi import topology as t


def test_every_kind_belongs_to_a_declared_zone():
    zone_ids = {zone["id"] for zone in t.ZONES}
    for kind, spec in t.KINDS.items():
        assert spec["zone"] in zone_ids, f"{kind} sits in an unknown zone"


def test_every_edge_endpoint_is_a_real_kind():
    """A typo in ALLOWED_EDGES would silently forbid a legal connection."""
    for from_kind, to_kinds in t.ALLOWED_EDGES.items():
        assert from_kind in t.KINDS, from_kind
        for to_kind in to_kinds:
            assert to_kind in t.KINDS, f"{from_kind} -> {to_kind}"


def test_every_kind_has_an_adjacency_entry():
    """Missing means "no legal targets", which should be stated, not implied."""
    assert set(t.ALLOWED_EDGES) == set(t.KINDS)


@pytest.mark.parametrize(
    "from_kind,to_kind",
    [
        ("source", "source_insert_function"),
        # Straight through, with no hub in the middle. "Everything goes through
        # Segment" is now said by the `segment` zone containing both ends.
        ("source", "destination"),
        ("source", "warehouse"),
        ("source", "space"),
        ("source_function", "destination"),
        ("source_insert_function", "destination"),
        ("destination_filter", "destination"),
        ("space", "computed_trait"),
        ("space", "audience"),
        ("computed_trait", "audience"),
        ("audience", "journey"),
        ("audience", "destination"),
        ("warehouse", "reverse_etl_model"),
        ("reverse_etl_model", "destination"),
        # Schema controls sit between the source and everything downstream of it, so
        # they have to accept the source and then reach the same set the source does.
        ("source", "source_schema_control"),
        ("source_schema_control", "destination"),
        ("source_schema_control", "space"),
        # A mapping is what an actions destination's connection actually consists of.
        ("destination_filter", "destination_mapping"),
        ("destination_mapping", "destination"),
        # Protocols points *at* what enforces it, which is the direction that makes the
        # arrow readable: the plan is upstream of the gate, not downstream of the source.
        ("tracking_plan", "source_schema_control"),
        ("event_library", "tracking_plan"),
        ("property_library", "tracking_plan"),
        # Profiles Sync is fed by both products and lands in a warehouse.
        ("space", "profile_sync"),
        ("audience", "profile_sync"),
        ("profile_sync", "warehouse"),
        # A destination's own mapping detail is drawn hanging off it, and Profiles
        # Sync's "audience membership from Engage" input is drawn from the
        # destination an audience activates.
        ("destination", "destination_mapping"),
        ("destination", "profile_sync"),
        # The same source drawn twice -- once in Connections, once again as a feeder
        # of Unify's profiles -- and an edge between the two copies says so.
        ("source", "source"),
        # What identity_resolution produces, a profile drives the same downstream as
        # identity_resolution itself when a diagram has no separate node to draw the
        # fan-out from.
        ("profile", "audience"),
        ("profile", "computed_trait"),
        ("profile", "journey"),
        # A walkthrough exercises any of these by feeding events into the debugger's
        # source.
        ("audience", "source"),
        ("computed_trait", "source"),
        ("journey", "source"),
        # A source drawn as a Profile Source reaches a profile directly, the same
        # allowance `profile`'s own incoming edges get when there is no separate
        # identity_resolution node to draw the fan-out from.
        ("source", "profile"),
    ],
)
def test_legal_edges(from_kind, to_kind):
    assert t.is_valid_edge(from_kind, to_kind)


@pytest.mark.parametrize(
    "from_kind,to_kind",
    [
        # Backwards: nothing flows from a destination into a source.
        ("destination", "source"),
        # A source function runs before Segment, so nothing reaches one from
        # inside the pipeline.
        ("destination", "source_function"),
        ("source_insert_function", "source_function"),
        # Engage cannot feed Unify's identity resolution.
        ("audience", "identity_resolution"),
        # A destination filter is not a source of profile data.
        ("destination_filter", "space"),
        # Terminals.
        ("destination_function", "destination"),
        ("profile_api", "audience"),
        ("identity_setting", "space"),
        # One gate per source, not a chain of them: schema controls are a single
        # settings page, so two in a row would depict something with no counterpart.
        ("source_schema_control", "source_schema_control"),
        # Protocols describes what may enter, so nothing routes *through* a plan.
        ("tracking_plan", "destination"),
        ("source", "tracking_plan"),
        # The sync is a terminal into the warehouse. Engage feeds it; it feeds nothing
        # back, or the diagram would show audience membership looping.
        ("profile_sync", "audience"),
        ("profile_sync", "space"),
    ],
)
def test_illegal_edges(from_kind, to_kind):
    assert not t.is_valid_edge(from_kind, to_kind)


def test_zone_placement():
    assert t.is_valid_placement("source", t.ZONE_CONNECTIONS)
    assert t.is_valid_placement("audience", t.ZONE_ENGAGE)
    assert t.is_valid_placement("computed_trait", t.ZONE_UNIFY)
    # The specific misplacement the brief calls out: Unify components must not be
    # droppable into the Connections pipeline.
    assert not t.is_valid_placement("computed_trait", t.ZONE_CONNECTIONS)
    assert not t.is_valid_placement("source", t.ZONE_ENGAGE)


def test_a_kind_is_valid_in_any_sub_zone_of_its_own_zone():
    """
    A computed trait belongs in Unify, and Profiles is inside Unify.

    This is what stops the new sub-zones from making every diagram that predates
    them wrong, and what lets a user file components more precisely without a
    second rule table saying which sub-zone each kind may go in.
    """
    assert t.is_valid_placement("computed_trait", t.ZONE_PROFILES)
    assert t.is_valid_placement("audience", t.ZONE_COMPUTATIONS)
    assert t.is_valid_placement("audience", t.ZONE_DEBUGGER)


def test_a_kind_is_valid_in_the_product_zone_its_home_subdivides():
    """
    The other direction, and only over subdivisions.

    Profiles, Profile Sources and Identity Resolution Settings are optional boxes
    inside Unify -- a diagram may draw them or may not. So a profile dropped on the
    bare Unify backdrop is filed correctly, and reporting it as belonging in Profiles
    named a zone that need not be on the canvas at all. That was the warning the
    console was full of.
    """
    assert t.is_valid_placement("profile", t.ZONE_UNIFY)
    assert t.is_valid_placement("profile_source", t.ZONE_UNIFY)
    assert t.is_valid_placement("identity_setting", t.ZONE_UNIFY)


def test_the_ascent_stops_at_the_product_and_does_not_go_sideways():
    """
    Both bounds on the rule above, because it is the half that can silently go total.

    Unify is not a subdivision of Segment, so the walk stops there and the Segment
    backdrop still admits nothing -- a component there would be in no product at all,
    which is the state the zone rule exists to prevent.

    And ascending then descending is not the same as either: Profiles and Profile
    Sources are both inside Unify, so a combined chain would make a profile legal in
    Profile Sources. That sideways move between siblings is the one misfiling among
    the subdivisions that is real, and it stays refused.
    """
    assert not t.is_valid_placement("profile", t.ZONE_SEGMENT)
    assert not t.is_valid_placement("profile", t.ZONE_PROFILE_SOURCES)
    assert not t.is_valid_placement("profile_source", t.ZONE_PROFILES)
    assert not t.is_valid_placement("identity_setting", t.ZONE_PROFILES)
    assert not t.is_valid_placement("identity_setting", t.ZONE_ENGAGE)


def test_identity_resolution_settings_live_in_unify():
    """
    Where the product puts them, and where the frontend was already drawing them.

    canvas/kinds.js has coloured this zone with Unify's border since it was added,
    with a comment saying the brief filed it under Engage but that identity
    resolution is a Unify concept. Two answers to one question; this is the one that
    survives. The rules are configured on a Unify space, which is also what makes
    "saved per Unify Space" a coherent thing to ask for.
    """
    assert t.ZONE_PARENT[t.ZONE_IDENTITY_SETTINGS] == t.ZONE_UNIFY
    assert t.zone_chain(t.ZONE_IDENTITY_SETTINGS) == [
        t.ZONE_IDENTITY_SETTINGS,
        t.ZONE_UNIFY,
        t.ZONE_SEGMENT,
    ]


def test_nesting_is_not_transitive_across_products():
    """
    Connections and Unify are both inside Segment, so a rule satisfied by a shared
    ancestor would let a warehouse into Unify. Nothing in the subdivision relaxation
    touches this: Connections is not a subdivision of Segment, so a warehouse's
    placement zones are Connections and nothing else.
    """
    assert not t.is_valid_placement("warehouse", t.ZONE_UNIFY)
    assert not t.is_valid_placement("warehouse", t.ZONE_SEGMENT)
    assert not t.is_valid_placement("audience", t.ZONE_SEGMENT)
    assert t.placement_zones("warehouse") == [t.ZONE_CONNECTIONS]


def test_protocols_is_inside_connections_and_homes_its_own_kinds():
    """
    Protocols is a product with its own docs and its own zone colour, but a tracking
    plan does nothing until a source enforces it -- so it nests inside Connections
    rather than sitting beside it, and the chain is what says so.
    """
    assert t.zone_chain(t.ZONE_PROTOCOLS) == [
        t.ZONE_PROTOCOLS,
        t.ZONE_CONNECTIONS,
        t.ZONE_SEGMENT,
    ]
    assert set(t.KINDS_BY_ZONE[t.ZONE_PROTOCOLS]) == {
        "tracking_plan",
        "event_library",
        "property_library",
    }


def test_protocols_kinds_do_not_escape_upwards_into_connections():
    """
    The one sub-zone that is not a subdivision, and the reason the flag is declared
    rather than derived.

    A source may be filed in Protocols -- Protocols is inside Connections, and the
    rule admits any descendant of a kind's home. A tracking plan in bare Connections
    is the reverse of that and stays refused, which is what keeps the sub-zone
    meaning "these three kinds live here" rather than being decoration. Deriving
    subdivision-ness from anything structural -- depth, or homing no kinds of its own
    -- would have swept Protocols in and lost this.
    """
    assert not t.ZONE_SUBDIVISION[t.ZONE_PROTOCOLS]
    assert t.is_valid_placement("tracking_plan", t.ZONE_PROTOCOLS)
    assert not t.is_valid_placement("tracking_plan", t.ZONE_CONNECTIONS)
    assert not t.is_valid_placement("tracking_plan", t.ZONE_UNIFY)
    assert t.is_valid_placement("source", t.ZONE_PROTOCOLS)


def test_zone_chain_is_innermost_first():
    assert t.zone_chain(t.ZONE_PROFILES) == [t.ZONE_PROFILES, t.ZONE_UNIFY, t.ZONE_SEGMENT]
    assert t.zone_chain(t.ZONE_SEGMENT) == [t.ZONE_SEGMENT]
    assert t.zone_chain(None) == []
    # A custom zone the user drew is not in the table; it has no ancestry to walk.
    assert t.zone_chain("their_own_app") == ["their_own_app"]


def test_no_zone_is_its_own_ancestor():
    """
    ZONES is hand-written, so a cycle is a typo away, and `zone_chain` guards
    against one rather than hanging. This asserts the table is actually acyclic --
    otherwise the guard would quietly become the thing keeping the app up.
    """
    for zone in t.ZONES:
        chain = t.zone_chain(zone["id"])
        assert len(chain) == len(set(chain)), f"{zone['id']} sits in a cycle: {chain}"
        assert t.ZONE_PARENT[chain[-1]] is None, f"{zone['id']} has no root"


def test_unknown_kind_has_no_zone_and_no_edges():
    assert t.expected_zone("not_a_kind") is None
    assert not t.is_valid_edge("not_a_kind", "source")


def test_source_functions_run_before_and_destination_side_after():
    """The brief's before/after-Segment requirement, encoded."""
    assert t.EDGE_PHASE["source_function"] == "pre"
    assert t.EDGE_PHASE["source_insert_function"] == "pre"
    assert t.EDGE_PHASE["destination_filter"] == "post"
    assert t.EDGE_PHASE["destination_insert_function"] == "post"
    assert t.EDGE_PHASE["destination_function"] == "post"
    assert t.EDGE_PHASE["destination_mapping"] == "post"


def test_schema_controls_are_given_no_phase():
    """
    Absence asserted, because the obvious next edit is to fill it in.

    Every other gate is before or after Segment's own validation. Schema controls
    *are* that validation, so either answer would be wrong -- and a third value in a
    two-valued field would have to be handled everywhere the phase is read.
    """
    assert "source_schema_control" not in t.EDGE_PHASE
    assert t.as_payload()["kinds"]["source_schema_control"]["edgePhase"] is None


def test_journeys_are_marked_as_not_api_discoverable():
    """There is no Journeys Public API. The UI must not promise auto-discovery."""
    assert t.KINDS["journey"]["api"] is False


def test_payload_is_serializable_and_complete():
    payload = t.as_payload()
    assert set(payload) == {"zones", "kinds", "kindsByZone"}
    for kind, spec in payload["kinds"].items():
        assert "allowedTargets" in spec
        assert "edgePhase" in spec
        assert isinstance(spec["allowedTargets"], list)  # sets are not JSON


# Zones that organise rather than home a kind. Each for its own reason, and the
# reasons are why this is a list and not a `structural` flag on the zone:
#
#   segment       contains the three products and nothing else.
#   computations  is somewhere to *put* audiences and journeys; their home stays
#                 `engage` so diagrams saved before the sub-zone existed are valid.
#   debugger      is filled by running the walkthrough, not by dropping anything.
#
# The last three are the same decision as `computations`, taken again and for the same
# reason: `source`, `destination` and `warehouse` keep `connections` as their home zone,
# so a diagram drawn before these existed stays valid and a source dropped straight onto
# Connections is still where it belongs. Moving the kinds in here would instead make
# every existing template and saved diagram misplaced, which is not what was asked for
# -- these zones were asked for as a way to *box off* part of Connections.
STRUCTURAL_ZONES = {
    t.ZONE_SEGMENT,
    t.ZONE_COMPUTATIONS,
    t.ZONE_DEBUGGER,
    t.ZONE_SOURCES,
    t.ZONE_DESTINATIONS,
    t.ZONE_WAREHOUSES,
}


def test_palette_only_zones_are_still_offered_in_the_palette():
    """
    The other half of test_graph.py's `test_palette_only_zones_are_not_shipped...`.

    Keeping them out of a workspace fetch is one line in `build_graph`, and the obvious
    way to write that line is to take them out of ZONES -- which would also take them
    out of the topology payload the palette builds its draggable list from, leaving three
    zones that exist in Python and can never be drawn.
    """
    offered = {zone["id"] for zone in t.as_payload()["zones"]}
    assert set(t.PALETTE_ONLY_ZONES) <= offered

    for zone_id in t.PALETTE_ONLY_ZONES:
        assert t.ZONE_PARENT[zone_id] == t.ZONE_CONNECTIONS


def test_every_zone_either_homes_a_kind_or_is_structural():
    """
    Asserted both ways round on purpose. A zone with no kinds shows an empty
    heading in the palette; a *structural* zone that gains one has quietly become
    a component's home, and whether the sub-zone or its parent is that home is a
    decision, not something to discover from a palette that changed shape.
    """
    for zone in t.ZONES:
        homed = t.KINDS_BY_ZONE[zone["id"]]
        if zone["id"] in STRUCTURAL_ZONES:
            assert not homed, f"{zone['id']} now homes {homed}; decide, then update this list"
        else:
            assert homed, f"{zone['id']} homes nothing"


# --- What the frontend has to have for each of these ------------------------
# The two tests below are the only ones here that read a JS file, and they have to:
# the tables they check against live on the other side of the language boundary, so
# a kind or zone added in this file with no counterpart there is invisible to a test
# that can only see one side.
#
# Both check for *presence*, never for content. That a warehouse is grey is a fact
# about the frontend and none of Python's business; that a zone this file declares has
# somewhere to look up its colour at all is a fact about both.

# The failure this one prevents is a component the walkthrough silently skips, which
# is exactly the component someone stopped to ask about.

NARRATION_JS = (
    Path(__file__).resolve().parent.parent / "frontend/src/simulation/narration.js"
)


def _narrated_kinds() -> set[str]:
    source = NARRATION_JS.read_text()
    table = re.search(r"^const NARRATION = \{$(.*?)^\}$", source, re.S | re.M)
    assert table, f"could not find the NARRATION table in {NARRATION_JS}"
    return set(re.findall(r"^  (\w+): \{$", table.group(1), re.M))


def test_every_kind_has_walkthrough_narration():
    missing = set(t.KINDS) - _narrated_kinds()
    assert not missing, f"no anchor narration for {sorted(missing)} in {NARRATION_JS}"


# `zoneStyleFor` falls back to the custom-zone grey for an id it does not know, which is
# right for a zone the user drew and wrong for one this file declares: a new product zone
# would render in the neutral grey that means "not a Segment product" and look deliberate.
KINDS_JS = Path(__file__).resolve().parent.parent / "frontend/src/canvas/kinds.js"


def _styled_zones() -> set[str]:
    source = KINDS_JS.read_text()
    table = re.search(r"^export const ZONE_STYLES = \{$(.*?)^\}$", source, re.S | re.M)
    assert table, f"could not find the ZONE_STYLES table in {KINDS_JS}"
    return set(re.findall(r"^  (\w+):", table.group(1), re.M))


def test_every_zone_has_a_style():
    missing = {zone["id"] for zone in t.ZONES} - _styled_zones()
    assert not missing, f"no zone style for {sorted(missing)} in {KINDS_JS}"


# --- The same zone more than once -------------------------------------------
#
# One canvas can hold several diagrams side by side, divided by a frame, so a zone may
# appear more than once -- and two zones sharing an id would collide in the document.
# The copy gets `connections~2`, and every rule here has to keep answering about
# Connections. The failure if one of them does not is not a crash: it is an advisory on
# every component in the copy, on every save, telling the user their diagram is wrong.


def test_zone_product_is_the_identity_for_a_zone_that_appears_once():
    for zone in t.ZONES:
        assert t.zone_product(zone["id"]) == zone["id"]


def test_zone_product_reads_a_copy_back_to_its_product():
    assert t.zone_product("connections~2") == "connections"
    assert t.zone_product("profile_sources~10") == "profile_sources"


def test_zone_product_leaves_the_other_id_shapes_alone():
    # A custom zone is `custom:zone:ab12`; neither separator collides with the tilde,
    # which is why the tilde was chosen.
    assert t.zone_product("custom:zone:ab12") == "custom:zone:ab12"
    assert t.zone_product(None) is None
    assert t.zone_product("") == ""


def test_a_copied_zone_takes_the_same_components():
    assert t.is_valid_placement("source", "connections~2")
    assert not t.is_valid_placement("audience", "connections~2")


def test_a_copied_subdivision_keeps_the_upward_rule():
    # A profile on the bare Unify backdrop is filed correctly, and so is one on the
    # second Unify backdrop.
    assert t.is_valid_placement("profile", "unify~2")
