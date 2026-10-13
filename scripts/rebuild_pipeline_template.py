"""
One-off: rebuild the `end-to-end-full-pipeline` fixture entry from the reviewed export.

Kept in the repo rather than run and thrown away, because what it encodes is not the diagram --
that is in templates.json now -- but the *decisions* taken while transcribing it: which `manual:`
ids became which stable ones, which style fields were dropped, and which two edges were changed.
Re-running it against the same export reproduces the fixture byte for byte, which is the only way
to check the transcription by anything other than eye.

The export it reads is the one attached to the request (2026-09-22), reproduced inline below so
this does not depend on a file in somebody's Downloads folder.
"""

import json
from collections import OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "apps/diagrams/fixtures/templates.json"
EXPORT = Path(__file__).resolve().parent / "end-to-end-export.json"

# A shipped template's node ids are referenced by its own scenario and by anyone binding against
# it, so `manual:destination:9fd17656` -- which says "a user dropped this, and the suffix is
# random" -- is the wrong thing to ship. Every node gets a `ph:` id naming what it is.
RENAME = {
    "manual:linked_audience:7a4178d7": "ph:linked-audience",
    "manual:destination:9fd17656": "ph:engage-destination",
    "manual:reverse_etl_model:842013e2": "ph:reverse-etl-model",
    "manual:warehouse:62748910": "ph:warehouse-upstream",
    "manual:warehouse:89e8083c": "ph:warehouse-sync-target",
    "manual:destination:10d140e1": "ph:downstream-destination",
    "manual:custom:925c8cad": "ph:linked-event",
}

# The zone a renamed node lands in, where the export's own answer is being changed.
#
# A position is *parent-relative*, so moving a node between zones has to translate it or the node
# lands somewhere else entirely -- and because `growZones` then stretches the new parent to cover
# it, the symptom is a zone three times its drawn height rather than a card in the wrong place.
# `_translate` below does that, from the zone geometry the export already carries.
REZONE = {
    # Profiles Sync writes into a warehouse, and that warehouse is the one inside Segment. Asked
    # for directly; `ALSO_VALID_ZONES` in topology.py is what makes it advisory-free.
    "ph:profiles-sync": "warehouses~2",
    # The export had a `custom` node in a Linked Audiences box relabelled by hand. Both are real
    # now -- see `linked_event` and ZONE_LINKED_EVENTS in topology.py. Same zone geometry, only
    # renamed, so nothing to translate.
    "ph:linked-event": "linked_events",
}

# The look every component on this diagram has: the same constant a palette or catalog drop
# applies (`DROPPED_STYLE` in frontend/src/canvas/Canvas.jsx). No `border` and no `bg`, so the
# colour comes from whichever zone the card sits in -- which is what makes recolouring a region
# recolour its contents, and what the export's one hard-coded `#f75a3b` was defeating.
STANDARD_STYLE = OrderedDict(
    [("borderStyle", "solid"), ("borderWidth", 1), ("shape", "rounded")]
)

# Kinds that are drawings rather than components and keep their own defaults, mirroring
# `DRAWING_KINDS` at the same drop site.
DRAWING_KINDS = {"shape", "table"}

# Fields that are derived at seed time (`_build_node`) or are live canvas state. Carrying them in
# the fixture would either be ignored or, worse, go stale against the file that owns them.
DROP_FROM_NODE = {
    "bound",
    "bindable",
    "synthetic",
    "docsUrl",
    "workspaceUrl",
    "linkVerified",
    "collapsed",
    "zone",
    "style",
    "segmentName",
    "details",
    "binds",
}

# The two edges being changed, by their export ids.
#
# The zone-to-zone line was deliberate but drawn between the wrong things: what it meant is that
# the debugger's source feeds the profile, and a line between two *backdrops* cannot say that. Now
# `ph:debugger-source -> ph:profile`, which is already legal (`source` reaches `profile` in
# ALLOWED_EDGES, for the stated reason that it is how profiles get populated).
RETARGET = {
    "xy-edge__zone-debuggerw-zone-profiless": {
        "source": "ph:debugger-source",
        "target": "ph:profile",
        "sourceHandle": "s",
        "targetHandle": "s",
        # Dropped: the route was bent to run between two zone backdrops and means nothing between
        # these two components. Left to the router instead.
        "drop": ("waypoints", "routed", "targetAnchor", "sourceAnchor"),
    },
}

# Descriptions rewritten since the export, kept from the working tree because they read better.
DESCRIPTIONS = {
    "ph:source-web": (
        "The point where events come into Segment. A source on the bare Connections backdrop is "
        "filed just as correctly."
    ),
    "ph:destination": (
        "The point where events go out from Segment. An actions destination does nothing until a "
        "mapping says what to send it."
    ),
    "ph:mapping": (
        "The trigger and the field mapping, the last thing that touches the payload before it "
        "becomes this destination's own API call."
    ),
    "ph:identity-rule": (
        "One identity resolution rule, which identifiers may collapse two events into one "
        "profile. Maintained by hand; Segment publishes no API for these."
    ),
    "ph:profile": (
        "A unified user profile, aggregated from the Unify Space's collective sources to add "
        "identifiers, traits and events per profile."
    ),
    "ph:audience": "Computed from profiles, and what many journeys are keyed on.",
    "ph:computed-trait": "Configured in Unify & Engaged from Track or Page events.",
    "ph:custom-app": (
        "Whatever the customer runs that Segment does not -- their own service, a job, a queue."
    ),
    "ph:profiles-sync": (
        "Takes profiles and traits from Unify and audience membership from Engage and lands both "
        "in one warehouse. Drawn in the warehouse it writes to, which is the half of its job a "
        "diagram can show."
    ),
    "ph:linked-event": (
        "A warehouse entity joined onto an outbound event, so the destination receives the whole "
        "row rather than the id the event carried. Reads from a cache on a schedule, not live."
    ),
    "ph:segment-profiles": (
        "The Segment Profiles destination: how a source's events reach a Unify Space."
    ),
    "ph:debugger-source": (
        "The source which generates the data from audiences, computed traits, journeys and linked "
        "audiences and sends it to their connected destinations. Debugger sources should never be "
        "modified by the customer."
    ),
    "ph:reverse-etl-model": (
        "A query against the customer's own warehouse, on a schedule. The way data that was never "
        "an event gets into Segment."
    ),
    "ph:warehouse-upstream": (
        "A warehouse the customer already had. Reverse ETL reads from it; Segment does not own it."
    ),
    "ph:warehouse-sync-target": (
        "The warehouse Profiles Sync writes into, and Linked Audiences reads back from."
    ),
    "ph:linked-audience": (
        "Membership decided by walking warehouse entities through a Data Graph, not by matching "
        "event history -- so it is recomputed on its own schedule."
    ),
    "ph:engage-destination": (
        "Where an audience is activated. Connected directly to the audience or computed trait, "
        "with its own mapping; the source behind it is abstracted and never configured."
    ),
    "ph:downstream-destination": (
        "A destination outside Segment: the tool that finally receives the event."
    ),
    "ph:journey": (
        "Hand-authored. There is no Journeys API, so this one never binds to anything and is not "
        "counted as a placeholder."
    ),
    "ph:profile-source": (
        "The same source again, as a feeder of profiles. Whether a source is connected to the "
        "space is a separate switch from the source existing, and it is the commonest reason "
        "Unify sees nothing."
    ),
}

# `binds` hints, required by `_build_node` for anything bindable. Carried here rather than taken
# from the export, which had lost them on several nodes.
BINDS = {
    "ph:source-web": {"kind": "source"},
    "ph:profile-source": {"kind": "source"},
    "ph:debugger-source": {"kind": "source"},
    "ph:destination": {"kind": "destination"},
    "ph:mapping": {"kind": "destination_mapping"},
    "ph:segment-profiles": {"kind": "destination"},
    "ph:engage-destination": {"kind": "destination"},
    "ph:downstream-destination": {"kind": "destination"},
    "ph:audience": {"kind": "audience"},
    "ph:computed-trait": {"kind": "computed_trait"},
    "ph:warehouse-upstream": {"kind": "warehouse"},
    "ph:warehouse-sync-target": {"kind": "warehouse"},
    "ph:reverse-etl-model": {"kind": "reverse_etl_model"},
}

NAMES = {"ph:linked-event": "Linked Event", "ph:linked-audience": "Linked Audience"}

# What `zoneStyleFor` resolves a zone's border to when the zone states no colour of its own --
# `ZONE_STYLES` in frontend/src/canvas/kinds.js, read through the CSS variables in
# styles/tokens.css. Restated here for one purpose: telling a colour the export merely *copied*
# from the palette apart from one somebody chose.
#
# The copies are dropped. A hex in the fixture is a hex frozen at the moment of transcription, so
# a template carrying the palette's own values would stop tracking it -- recolouring Connections
# would leave five diagrams blue. The deliberate ones are kept, because they are the drawing.
PALETTE_BORDER = {
    "segment": "#121c2d",
    "connections": "#0263e0",
    "sources": "#0263e0",
    "destinations": "#0263e0",
    "warehouses": "#0263e0",
    "linked_events": "#0263e0",
    "unify": "#6f42c1",
    "profile_sources": "#6f42c1",
    "profiles": "#6f42c1",
    "engage": "#db131a",
    "debugger": "#db131a",
    "linked_audiences": "#db131a",
}


def _origin(zone_id, by_id):
    """A zone's origin in flow coordinates, summed through its ancestors.

    Mirrors `zoneOrigin` in frontend/src/canvas/rules.js: a sub-zone's stored position is relative
    to its parent, at every level, so a point cannot be compared between two zones without this.
    """
    x = y = 0
    seen = set()
    current = zone_id
    while current and current in by_id and current not in seen:
        seen.add(current)
        zone = by_id[current]
        x += zone["position"]["x"]
        y += zone["position"]["y"]
        current = zone.get("parent")
    return x, y


def _translate(position, from_zone, to_zone, by_id):
    """The same point on screen, expressed relative to a different zone."""
    from_x, from_y = _origin(from_zone, by_id)
    to_x, to_y = _origin(to_zone, by_id)
    return {
        "x": round(position["x"] + from_x - to_x),
        "y": round(position["y"] + from_y - to_y),
    }


def main() -> None:
    export = json.loads(EXPORT.read_text())
    graph = export["graph"]
    rename = lambda node_id: RENAME.get(node_id, node_id)  # noqa: E731
    zones_by_id = {zone["id"]: zone for zone in graph["zones"]}
    # The relabelled box becomes the real zone in place, so `linked_events` is the same geometry
    # under a new id. Aliased here rather than special-cased at the translation site: to `_origin`
    # the two names describe one box, which is exactly what makes the translation a no-op.
    zones_by_id["linked_events"] = zones_by_id["linked_audiences~2"]

    zones = []
    for zone in graph["zones"]:
        out = {
            "id": zone["id"],
            "label": zone.get("label"),
            "description": zone.get("description"),
            "position": zone["position"],
            "width": zone["width"],
            "height": zone["height"],
        }
        if zone.get("parent"):
            out["parent"] = zone["parent"]
        if zone.get("custom"):
            out["custom"] = True
        # A colour only where it is a decision rather than a copy of the palette -- see
        # PALETTE_BORDER. Resolved by product, so `warehouses~3`'s orange is compared against the
        # blue the Warehouse subdivision would otherwise take, and kept.
        product = zone["id"].split("~")[0]
        if zone.get("color") and zone["color"] != PALETTE_BORDER.get(product):
            out["color"] = zone["color"]
        zones.append(out)

    # The Linked Audiences copy, relabelled "Linked Events" by hand, becomes the real zone -- so
    # its label and description come from topology.py like every other product zone's, and the
    # orange it was given by hand is dropped in favour of the palette's own. Done after the loop
    # because the colour test above has to judge it as the zone it *was*.
    for zone in zones:
        if zone["id"] == "linked_audiences~2":
            zone["id"] = "linked_events"
            zone["parent"] = "connections"
            zone.pop("label", None)
            zone.pop("description", None)
            zone.pop("color", None)

    nodes = []
    for node in graph["nodes"]:
        node_id = rename(node["id"])
        kind = "linked_event" if node_id == "ph:linked-event" else node["kind"]
        was = node.get("zone")
        zone = REZONE.get(node_id, was)
        position = (
            node["position"]
            if zone == was
            else _translate(node["position"], was, zone, zones_by_id)
        )
        out = {
            "id": node_id,
            "kind": kind,
            "name": NAMES.get(node_id, node.get("name")),
            "position": position,
            "zone": zone,
            "description": DESCRIPTIONS.get(node_id, node.get("description") or ""),
        }
        if node.get("size"):
            out["size"] = node["size"]
        if node.get("rules"):
            out["rules"] = node["rules"]
        if node_id in BINDS:
            out["binds"] = BINDS[node_id]
        if kind not in DRAWING_KINDS:
            out["style"] = dict(STANDARD_STYLE)
        # Every card keeps its description off its own face: these are written for the sidebar,
        # and forty of them printed on one diagram is unreadable. Matches `cardFields.js`'s own
        # default, stated here because the export stated it.
        out["showFields"] = {"description": False}
        for key in DROP_FROM_NODE - {"zone", "style", "binds"}:
            out.pop(key, None)
        nodes.append(out)

    edges = []
    for edge in graph["edges"]:
        change = RETARGET.get(edge["id"])
        out = {
            "source": rename(change["source"] if change else edge["source"]),
            "target": rename(change["target"] if change else edge["target"]),
        }
        for field in ("sourceHandle", "targetHandle", "sourceAnchor", "targetAnchor", "waypoints"):
            value = (change or {}).get(field, edge.get(field))
            if value and field not in (change or {}).get("drop", ()):
                out[field] = value
        # The id is derived from the ends by `_build_edge` when absent, which is what a
        # transcribed template wants: an `xy-edge__` id is React Flow's own minting and says
        # nothing once the ends have been renamed.
        edges.append(out)

    entry = {
        "key": "end-to-end-full-pipeline",
        "name": "End-to-end Connections & Unify",
        "description": export["description"],
        "category": "Reference architecture",
        # First in the list -- `Template.Meta.ordering` is `["sort_order", "name"]`. This is the
        # one to start from when the point is to show somebody the shape of the whole thing.
        "sort_order": 0,
        "zones": zones,
        "nodes": nodes,
        "edges": edges,
        "scenarios": graph.get("scenarios", []),
    }

    fixture = json.loads(FIXTURE.read_text())
    # Everything else moves down one to make room, keeping its relative order.
    order = ["web-mobile-unify-engage", "cloud-sources-reverse-etl", "end-to-end-test", "mtu-billing-view"]
    for template in fixture:
        if template["key"] in order:
            template["sort_order"] = order.index(template["key"]) + 1
    fixture = [entry] + [t for t in fixture if t["key"] != entry["key"]]
    FIXTURE.write_text(json.dumps(fixture, indent=2) + "\n")
    print(f"{len(nodes)} nodes, {len(edges)} edges, {len(zones)} zones")


if __name__ == "__main__":
    main()
