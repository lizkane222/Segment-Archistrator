"""
Server-side re-validation of a saved graph against the architecture rules.

The canvas already refuses illegal connections while you draw, so in normal use
this never fires. It exists because that enforcement is a UI affordance, not a
guarantee: a stale tab, a replayed request, or a hand-rolled POST can all reach
this endpoint. The rules live in topology.py and are served to the canvas from
there, so both sides check the same table.

Two kinds of finding, and the split is the point:

  - `validate_architecture` returns *errors*, which reject the save. Structural
    damage only -- a node with no kind, an edge to a node that is not in the
    graph. Which pairs of kinds may connect is not checked here at all: any
    component may connect to any other, including a zone to another zone or a
    node back to itself. ALLOWED_EDGES in topology.py still exists, but only for
    linting the bundled templates, not for a user-drawn edge.
  - `placement_advisories` returns *advice*, which never rejects anything. Which
    zone a component sits in used to be an error here, and that was wrong: some
    components genuinely belong to two products at once -- identity resolution
    settings are Unify's and Engage's both -- and the canvas outside every zone is
    now a working area where a component may legitimately have no zone at all.
    What the topology knows about where a thing usually goes is still worth
    saying, so it is said rather than enforced.

Deliberately tolerant in one direction. An unknown `kind` is ignored rather than
rejected, because the alternative is that adding a component kind to topology.py
retroactively makes every already-saved diagram unsaveable from an older tab. A
kind we do not recognise carries no rules we could be enforcing.
"""

from apps.segmentapi import topology

MAX_ERRORS = 12


def _fields(node: dict) -> dict:
    """React Flow keeps a node's payload under `data`; a template's is flat."""
    if not isinstance(node, dict):
        return {}
    return {**node, **(node.get("data") or {})}


def _custom_zones(graph: dict) -> set[str]:
    """
    Ids of zones the customer drew for somewhere outside Segment.

    Their contents are exempt from the zone-placement rule and nothing else. A
    warehouse acting as a reverse-ETL source, or the customer's own app, is not
    inside Segment's pipeline, so asking which of Connections/Unify/Engage it
    belongs to has no answer. The two alternatives are both worse: reject the
    diagram, which makes the feature unusable, or drop zone checks wholesale,
    which loses the rule for the zones it does apply to.
    """
    return {
        zone["id"]
        for zone in graph.get("zones") or []
        if isinstance(zone, dict) and zone.get("custom") and zone.get("id")
    }


def _zone_label(zone_id: str, graph: dict) -> str:
    """
    A zone's name as the user sees it on the canvas.

    Their own label first: a custom zone is named by the customer and the topology has
    never heard of it. Falls back to the raw id, which is better than nothing for a
    zone from a newer tab than this server.
    """
    for zone in graph.get("zones") or []:
        if isinstance(zone, dict) and zone.get("id") == zone_id and zone.get("label"):
            return zone["label"]
    for zone in topology.ZONES:
        if zone["id"] == zone_id:
            return zone["label"]
    return zone_id


def placement_notes(graph: dict) -> list[dict]:
    """
    Notes about components sitting somewhere other than their usual zone, with the id
    of the component each one is about.

    Never an error. Callers surface these; nothing acts on them. Kept beside the
    validator rather than in the view so there is one implementation of the rule and
    a new endpoint cannot accidentally ship a different opinion about it.

    The id is here so the canvas can point at the component rather than making the
    reader work out which of four destinations a note is about -- a message naming
    "Destination" on a diagram with three of them says almost nothing on its own.

    Silent about a component with no zone at all. That is the working area outside
    every zone, which is a deliberate place to put something, so remarking on it
    would be noise on every save.
    """
    custom_zones = _custom_zones(graph)
    notes: list[dict] = []

    for node in graph.get("nodes") or []:
        fields = _fields(node)
        kind = fields.get("kind")
        zone = fields.get("zone")
        # A container zone is skipped for the same reason no zone at all is: it is a
        # deliberate place to put something. The Segment backdrop says "inside
        # Segment" and does not claim to say which product owns it, which is the only
        # honest answer for a component that belongs to two.
        if zone in topology.CONTAINER_ZONES:
            continue
        if kind not in topology.KINDS or not zone or zone in custom_zones:
            continue
        # `is_valid_placement` walks topology.py's zone tree, not the tree the
        # document claims. A saved graph carries its own `parent` links, and
        # honouring those would let a request declare Unify a child of Connections
        # and get a different answer out of the same table.
        if topology.is_valid_placement(kind, zone):
            continue
        label = topology.KINDS[kind]["label"]
        name = fields.get("name") or fields.get("id")
        notes.append(
            {
                "nodeId": fields.get("id"),
                "message": (
                    f"{label} '{name}' is in {_zone_label(zone, graph)}; it usually goes "
                    f"in {_zone_label(topology.expected_zone(kind), graph)}."
                ),
            }
        )

    if len(notes) > MAX_ERRORS:
        remaining = len(notes) - MAX_ERRORS
        # No id on the summary line: it stands for several components, so pointing at
        # one of them would be worse than pointing at none.
        notes = notes[:MAX_ERRORS] + [{"nodeId": None, "message": f"...and {remaining} more."}]
    return notes


def placement_advisories(graph: dict) -> list[str]:
    """The messages from `placement_notes`, for callers that only want to say them."""
    return [note["message"] for note in placement_notes(graph)]


def validate_architecture(graph: dict) -> list[str]:
    """
    Return human-readable reasons the graph is not a valid architecture.

    Empty list means valid. Messages name the node and the rule, because the only
    reader who ever sees one is a developer working out why the canvas and the
    server disagree.

    Zone placement is *not* checked here -- see `placement_advisories`. Nor is
    which kinds may connect to which: an edge to a node that is not in the graph
    is a broken document however it got here, and that structural damage is what
    remains a refusal.
    """
    nodes = graph.get("nodes") or []
    edges = graph.get("edges") or []
    errors: list[str] = []

    kinds: dict[str, str] = {}
    for node in nodes:
        fields = _fields(node)
        node_id = fields.get("id")
        kind = fields.get("kind")
        if not node_id or not kind:
            errors.append(f"A node is missing its id or kind: {str(node)[:80]}")
            continue
        kinds[node_id] = kind

    # A zone has no kind -- it is not in `kinds` above -- but it is a legal edge
    # endpoint, so its id still has to count as known.
    zone_ids = {
        zone["id"]
        for zone in graph.get("zones") or []
        if isinstance(zone, dict) and zone.get("id")
    }

    for edge in edges:
        if not isinstance(edge, dict):
            errors.append(f"An edge is not an object: {str(edge)[:80]}")
            continue
        source, target = edge.get("source"), edge.get("target")
        known = kinds.keys() | zone_ids
        if source not in known or target not in known:
            missing = source if source not in known else target
            errors.append(f"Edge {source} -> {target} references a node that is not in the graph: {missing}.")
            continue

    if len(errors) > MAX_ERRORS:
        remaining = len(errors) - MAX_ERRORS
        errors = errors[:MAX_ERRORS] + [f"...and {remaining} more."]
    return errors
