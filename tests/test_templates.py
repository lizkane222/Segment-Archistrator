"""
The seeded reference architectures, and the rules a saved graph must satisfy.

The fixture tests matter more than they look. A template is the first thing a user
opens, and a template that encodes an illegal edge produces a diagram the canvas
will not draw and the API will not save -- a confusing first five minutes with no
obvious cause. seed_templates validates as it loads; these tests assert it really
does, and that the shipped fixture passes.
"""

import json

import pytest
from django.core.management import call_command
from django.core.management.base import CommandError

from apps.diagrams.management.commands import seed_templates as seed_module
from apps.diagrams.models import Diagram, Template, is_placeholder
from apps.diagrams.validators import placement_advisories, validate_architecture
from apps.segmentapi import topology

pytestmark = pytest.mark.django_db


@pytest.fixture
def seeded():
    call_command("seed_templates", verbosity=0)
    return Template.objects.all()


# --- The shipped fixture ----------------------------------------------------

def test_the_fixture_seeds_five_templates(seeded):
    assert seeded.count() == 5
    assert {t.key for t in seeded} == {
        "web-mobile-unify-engage",
        "cloud-sources-reverse-etl",
        "end-to-end-test",
        "mtu-billing-view",
        "end-to-end-full-pipeline",
    }


def test_seeding_twice_is_idempotent(seeded):
    call_command("seed_templates", verbosity=0)
    assert Template.objects.count() == 5


def test_a_derived_template_node_sits_in_the_zone_its_kind_requires(seeded):
    """
    A template that declares no zones states no placement either -- seed_templates
    derives it from topology.py. This asserts that derivation happened, since a node
    with a wrong or missing zone lands in the wrong pipeline on the canvas.
    """
    derived = [t for t in seeded if "zones" not in t.graph]
    assert derived, "the derived case is the default; something has gone wrong if none are"
    for template in derived:
        for node in template.graph["nodes"]:
            assert node["zone"] == topology.expected_zone(node["kind"]), (
                template.key,
                node["id"],
            )


def test_a_hand_arranged_template_places_nodes_only_in_zones_it_declared(seeded):
    """
    The other shape of template: it states a layout, so it may place a component
    somewhere other than its kind's usual zone -- Profiles Sync belongs to Unify and
    Engage both, and the canvas advises on that rather than refusing it. What it may
    *not* do is name a zone nothing draws, which would leave the component invisible
    on the backdrop instead of in the box the author meant.
    """
    arranged = [t for t in seeded if "zones" in t.graph]
    assert arranged, "end-to-end-full-pipeline is the hand-arranged one"
    for template in arranged:
        declared = {zone["id"] for zone in template.graph["zones"]}
        for node in template.graph["nodes"]:
            assert node["zone"] in declared or node["zone"] is None, (
                template.key,
                node["id"],
                node["zone"],
            )


def test_a_declared_zone_nests_inside_a_zone_that_is_also_declared(seeded):
    """
    A sub-zone's position is relative to its parent, so a parent that is not in the
    document leaves the child drawn against the wrong origin -- off by however far
    the missing zone sat from 0,0.
    """
    for template in seeded:
        declared = {zone["id"] for zone in template.graph.get("zones", [])}
        for zone in template.graph.get("zones", []):
            if zone.get("parent"):
                assert zone["parent"] in declared, (template.key, zone["id"])


def test_the_full_pipeline_template_keeps_its_regions_outside_segment(seeded):
    """
    The two custom zones are the reason this template declares zones at all: the
    topology has never heard of the customer's own warehouse, so there is no id to
    derive and no label to look up.
    """
    template = Template.objects.get(key="end-to-end-full-pipeline")
    custom = [z for z in template.graph["zones"] if z.get("custom")]
    assert [z["label"] for z in custom] == ["Destination", "App / Mobile / Server / Warehouse"]
    for zone in custom:
        # Beside Segment, not inside it. That is the whole claim they make.
        assert "parent" not in zone, zone["id"]
        assert zone["width"] and zone["height"] and zone["position"]


def test_every_hand_arranged_node_carries_a_position(seeded):
    """Without one the layout falls back to columns, which is the thing this shape of
    template exists not to do."""
    for template in [t for t in seeded if "zones" in t.graph]:
        for node in template.graph["nodes"]:
            assert "position" in node, (template.key, node["id"])


def test_every_edge_in_a_generated_template_is_legal(seeded):
    """
    A template that declares no zones is a claim about the shape of the pipeline, so every
    edge in one has to be on the adjacency table. A *hand-arranged* template is a drawing
    somebody made and is held to a weaker rule -- see the next test for what it may contain
    and why.

    Mirrors seed_templates.py's own bypass for a rule-free kind: `custom` has no adjacency
    table and no business getting one, so an edge touching it is legal by definition rather
    than something to look up.
    """
    for template in seeded:
        if template.graph.get("zones"):
            continue
        kinds = {n["id"]: n["kind"] for n in template.graph["nodes"]}
        for edge in template.graph["edges"]:
            from_kind, to_kind = kinds[edge["source"]], kinds[edge["target"]]
            if {from_kind, to_kind} & seed_module.RULE_FREE_KINDS:
                continue
            assert topology.is_valid_edge(from_kind, to_kind), (template.key, edge["id"])


def test_a_hand_arranged_template_may_hold_an_edge_that_is_not_data_flow(seeded):
    """
    The off-table edges a hand-arranged template is allowed to contain, named individually.

    Not a blanket exemption: the point of listing them is that adding a *fourth* has to be a
    deliberate edit to this test rather than something that slips in. Each of these is a
    drawing statement rather than a path an event takes --

      warehouse -> warehouse        "these two are usually the same warehouse"
      destination -> destination     a destination forwarding into the customer's own system
      source -> profile_sync        the debugger source drawn as the thing a walkthrough feeds

    -- and each is the kind of claim `ALLOWED_EDGES` cannot express, because that table is
    about which components Segment connects, not about what a diagram may say.
    """
    allowed_liberties = {
        ("warehouse", "warehouse"),
        ("destination", "destination"),
        ("source", "profile_sync"),
    }
    for template in seeded:
        if not template.graph.get("zones"):
            continue
        kinds = {n["id"]: n["kind"] for n in template.graph["nodes"]}
        for edge in template.graph["edges"]:
            pair = (kinds[edge["source"]], kinds[edge["target"]])
            if set(pair) & seed_module.RULE_FREE_KINDS:
                continue
            if topology.is_valid_edge(*pair):
                continue
            assert pair in allowed_liberties, (template.key, edge["id"], pair)


def test_the_segment_profiles_destination_may_reach_a_profile():
    """
    The gap that shipping a real hand-drawn diagram exposed.

    Segment Profiles is a destination in the catalogue and is what you configure in
    Connections, but what it feeds is a space -- so it is how profiles get populated at all.
    Without this pair the commonest path in Unify was the one thing a diagram could not draw.
    """
    assert topology.is_valid_edge("destination", "profile")


def test_a_linked_audience_may_reach_the_debugger_source():
    """
    `computed_trait`, `audience` and `journey` all already pointed at `source` -- the
    stand-in for "play a walkthrough and watch events arrive". A Linked Audience is the same
    kind of thing and was the one sibling missing it, which made it the only audience a
    walkthrough could not be drawn against.
    """
    assert topology.is_valid_edge("linked_audience", "source")


def test_shipped_templates_pass_the_same_validation_a_save_does(seeded):
    """If this fails, a user could open a template and then not be able to save it."""
    for template in seeded:
        assert validate_architecture(template.graph) == [], template.key


def test_every_bindable_node_carries_a_binds_hint(seeded):
    for template in seeded:
        for node in template.graph["nodes"]:
            if node["bindable"]:
                assert node["binds"]["kind"] == node["kind"], (template.key, node["id"])


def test_synthetic_nodes_arrive_bound(seeded):
    """
    Identity resolution and the Profile API have no resource to bind to, so they
    must not show up as work to do.
    """
    for template in seeded:
        for node in template.graph["nodes"]:
            if node["synthetic"]:
                assert node["bound"] is True
                assert node["bindable"] is False


def test_a_journey_is_unbound_but_not_a_placeholder(seeded):
    """
    There is no Journeys API. A journey node renders dashed -- correctly, it is
    unverified -- but counting it would leave a "1 placeholder to bind" banner
    that no amount of binding could clear.
    """
    template = Template.objects.get(key="web-mobile-unify-engage")
    journeys = [n for n in template.graph["nodes"] if n["kind"] == "journey"]
    assert journeys
    for node in journeys:
        assert node["bound"] is False
        assert node["bindable"] is False
        assert is_placeholder(node) is False


def test_placeholder_count_matches_the_bindable_nodes(seeded):
    for template in seeded:
        expected = sum(1 for n in template.graph["nodes"] if n["bindable"])
        assert template.placeholder_count == expected


def test_every_node_gets_a_docs_link_and_no_workspace_link(seeded):
    """A placeholder has no workspace resource, so it must not claim a link to one."""
    for template in seeded:
        for node in template.graph["nodes"]:
            # A rule-free kind is excepted, and the exception is the point of the
            # kind: a custom component stands for something the customer runs
            # themselves, and Segment has no documentation page for their service.
            if node["kind"] not in seed_module.RULE_FREE_KINDS:
                assert node["docsUrl"], (template.key, node["id"])
            assert node["workspaceUrl"] is None


# --- The loader's own guardrails --------------------------------------------

def _run_fixture(tmp_path, monkeypatch, payload):
    path = tmp_path / "templates.json"
    path.write_text(json.dumps(payload))
    monkeypatch.setattr(seed_module, "FIXTURE", path)
    call_command("seed_templates", verbosity=0)


def _two_nodes():
    return [
        {"id": "d", "kind": "destination", "binds": {"kind": "destination"}},
        {"id": "s", "kind": "source", "binds": {"kind": "source"}},
    ]


def test_an_illegal_edge_in_a_generated_fixture_fails_the_load(tmp_path, monkeypatch):
    """A template that states no layout is still held to the adjacency table."""
    with pytest.raises(CommandError, match="not in the adjacency table"):
        _run_fixture(
            tmp_path,
            monkeypatch,
            [
                {
                    "key": "bad",
                    "name": "Backwards",
                    "nodes": _two_nodes(),
                    "edges": [{"source": "d", "target": "s"}],
                }
            ],
        )
    assert not Template.objects.filter(key="bad").exists()


def test_the_same_edge_is_allowed_once_the_template_states_its_own_layout(tmp_path, monkeypatch):
    """
    The one that keeps the deploy green.

    A hand-arranged template is reproduced as drawn, and refusing an off-table edge here was
    the last thing that made a diagram the canvas accepts unshippable as the template it came
    from. It warns instead -- so a genuine gap in the table is still said out loud -- and it
    seeds.
    """
    _run_fixture(
        tmp_path,
        monkeypatch,
        [
            {
                "key": "drawn",
                "name": "As drawn",
                "zones": [
                    {
                        "id": "connections",
                        "position": {"x": 0, "y": 0},
                        "width": 400,
                        "height": 300,
                    }
                ],
                "nodes": _two_nodes(),
                "edges": [{"source": "d", "target": "s"}],
            }
        ],
    )
    template = Template.objects.get(key="drawn")
    assert [(e["source"], e["target"]) for e in template.graph["edges"]] == [("d", "s")]


def test_an_edge_keeps_the_route_it_was_drawn_with(tmp_path, monkeypatch):
    """
    The silent one.

    `_build_edge` used to return a fixed dict of id/source/target/phase/discovered, so every
    hand-placed anchor and every dragged corner was dropped on the way in. Nothing failed:
    the template validated, seeded, and opened -- looking nothing like the diagram it was made
    from. There is nothing to derive these from, so if they are not carried they are gone.
    """
    _run_fixture(
        tmp_path,
        monkeypatch,
        [
            {
                "key": "routed",
                "name": "Routed",
                "zones": [
                    {"id": "connections", "position": {"x": 0, "y": 0}, "width": 400, "height": 300}
                ],
                "nodes": _two_nodes(),
                "edges": [
                    {
                        "source": "s",
                        "target": "d",
                        "sourceHandle": "n",
                        "targetHandle": "w",
                        "sourceAnchor": "free:top:0.25",
                        "targetAnchor": "free:left:0.75",
                        "waypoints": [{"x": 10, "y": 20}, {"x": 30, "y": 40}],
                    }
                ],
            }
        ],
    )
    edge = Template.objects.get(key="routed").graph["edges"][0]
    assert edge["sourceHandle"] == "n"
    assert edge["targetHandle"] == "w"
    assert edge["sourceAnchor"] == "free:top:0.25"
    assert edge["targetAnchor"] == "free:left:0.75"
    assert edge["waypoints"] == [{"x": 10, "y": 20}, {"x": 30, "y": 40}]


def test_an_edge_drawn_with_no_route_stays_clean(tmp_path, monkeypatch):
    """
    The other half: absent keys stay absent rather than becoming nulls.

    A `sourceAnchor: null` is not the same as no anchor -- `serializeEdge` omits a falsy one
    and the edge falls back to its fixed handle, so writing the key at all would put a value
    into every saved copy of a diagram that never had one.
    """
    _run_fixture(
        tmp_path,
        monkeypatch,
        [
            {
                "key": "plain",
                "name": "Plain",
                "nodes": _two_nodes(),
                "edges": [{"source": "s", "target": "d"}],
            }
        ],
    )
    edge = Template.objects.get(key="plain").graph["edges"][0]
    for field in ("sourceHandle", "targetHandle", "sourceAnchor", "targetAnchor", "waypoints"):
        assert field not in edge


def test_the_shipped_pipeline_keeps_the_arrangement_it_was_drawn_with(seeded):
    """The hand-arranged template is the reason the two tests above exist."""
    graph = Template.objects.get(key="end-to-end-full-pipeline").graph
    anchored = [e for e in graph["edges"] if e.get("sourceAnchor") or e.get("targetAnchor")]
    routed = [e for e in graph["edges"] if e.get("waypoints")]
    assert len(anchored) == 22, "every connector in this diagram was placed by hand"
    assert len(routed) == 2


def test_a_template_may_ship_a_walkthrough(seeded):
    """
    A template with no path opens as a still diagram, and the walkthrough is the thing the app
    is for -- so the one hand-arranged reference architecture carries a path that plays.
    """
    graph = Template.objects.get(key="end-to-end-full-pipeline").graph
    assert len(graph["scenarios"]) == 1
    path = graph["scenarios"][0]
    ids = {n["id"] for n in graph["nodes"]}
    assert path["sourceId"] in ids
    # Ships ready to play rather than in somebody's working state: a template that opens with
    # nine components left out reads as a broken diagram, not as a curated view.
    assert path["excluded"] == []
    assert path["disabled"] == []


def test_a_walkthrough_that_starts_nowhere_fails_the_load(tmp_path, monkeypatch):
    """
    Otherwise it ships silently: a path whose `sourceId` names nothing simply never plays, and
    the reader is left wondering what they did wrong.
    """
    with pytest.raises(CommandError, match="does not contain"):
        _run_fixture(
            tmp_path,
            monkeypatch,
            [
                {
                    "key": "bad-path",
                    "name": "X",
                    "nodes": _two_nodes(),
                    "edges": [{"source": "s", "target": "d"}],
                    "scenarios": [{"id": "path:1", "sourceId": "ph:not-here"}],
                }
            ],
        )


def test_a_walkthrough_that_names_an_unknown_component_fails_the_load(tmp_path, monkeypatch):
    with pytest.raises(CommandError, match="unknown node"):
        _run_fixture(
            tmp_path,
            monkeypatch,
            [
                {
                    "key": "bad-path",
                    "name": "X",
                    "nodes": _two_nodes(),
                    "edges": [{"source": "s", "target": "d"}],
                    "scenarios": [{"id": "path:1", "sourceId": "s", "excluded": ["ph:gone"]}],
                }
            ],
        )


def test_a_template_with_no_walkthrough_says_so_by_omission(tmp_path, monkeypatch):
    """`scenarios` absent rather than `[]`, matching how `zones` is handled."""
    _run_fixture(
        tmp_path,
        monkeypatch,
        [{"key": "quiet", "name": "X", "nodes": _two_nodes(), "edges": []}],
    )
    assert "scenarios" not in Template.objects.get(key="quiet").graph


def test_an_unknown_kind_in_a_fixture_fails_the_load(tmp_path, monkeypatch):
    with pytest.raises(CommandError, match="unknown kind"):
        _run_fixture(
            tmp_path,
            monkeypatch,
            [{"key": "bad", "name": "X", "nodes": [{"id": "a", "kind": "lakehouse"}]}],
        )


def test_an_edge_to_a_missing_node_fails_the_load(tmp_path, monkeypatch):
    with pytest.raises(CommandError, match="unknown node"):
        _run_fixture(
            tmp_path,
            monkeypatch,
            [
                {
                    "key": "bad",
                    "name": "X",
                    "nodes": [{"id": "s", "kind": "source", "binds": {"kind": "source"}}],
                    "edges": [{"source": "s", "target": "nope"}],
                }
            ],
        )


def test_a_bindable_node_without_a_binds_hint_fails_the_load(tmp_path, monkeypatch):
    """Otherwise the binding panel opens with nothing to offer and no explanation."""
    with pytest.raises(CommandError, match="no `binds` hint"):
        _run_fixture(
            tmp_path, monkeypatch, [{"key": "bad", "name": "X", "nodes": [{"id": "s", "kind": "source"}]}]
        )


def test_binds_may_not_change_a_nodes_kind(tmp_path, monkeypatch):
    with pytest.raises(CommandError, match="Binding must not change"):
        _run_fixture(
            tmp_path,
            monkeypatch,
            [
                {
                    "key": "bad",
                    "name": "X",
                    "nodes": [
                        {"id": "s", "kind": "source", "binds": {"kind": "destination"}}
                    ],
                }
            ],
        )


def test_a_rule_free_kind_is_accepted_where_an_unknown_one_is_not(tmp_path, monkeypatch):
    """
    `custom` is deliberately not a topology kind -- it stands for something the
    customer runs themselves -- so it has to be admitted by name rather than by
    falling through the unknown-kind check that catches a typo.
    """
    _run_fixture(
        tmp_path,
        monkeypatch,
        [{"key": "ok", "name": "X", "nodes": [{"id": "c", "kind": "custom", "name": "Their API"}]}],
    )
    node = Template.objects.get(key="ok").graph["nodes"][0]
    assert node["kind"] == "custom"
    # No zone to derive, and nothing wrong with that: the working area is a real place.
    assert node["zone"] is None
    assert node["bindable"] is False


def test_an_edge_touching_a_rule_free_kind_skips_the_adjacency_lint(tmp_path, monkeypatch):
    """
    The table would otherwise say "nothing may connect to the customer's own
    service", which is false and is exactly why `custom` has no row in it.
    """
    _run_fixture(
        tmp_path,
        monkeypatch,
        [
            {
                "key": "ok",
                "name": "X",
                "nodes": [
                    {"id": "c", "kind": "custom"},
                    {"id": "s", "kind": "source", "binds": {"kind": "source"}},
                ],
                "edges": [{"source": "c", "target": "s"}],
            }
        ],
    )
    assert len(Template.objects.get(key="ok").graph["edges"]) == 1


def test_placing_a_node_in_an_undeclared_zone_fails_the_load(tmp_path, monkeypatch):
    """Nothing would draw the zone, so the component would land on the backdrop."""
    with pytest.raises(CommandError, match="does not declare"):
        _run_fixture(
            tmp_path,
            monkeypatch,
            [
                {
                    "key": "bad",
                    "name": "X",
                    "nodes": [
                        {
                            "id": "s",
                            "kind": "source",
                            "zone": "engage",
                            "binds": {"kind": "source"},
                        }
                    ],
                }
            ],
        )


def test_an_unknown_zone_id_fails_the_load(tmp_path, monkeypatch):
    with pytest.raises(CommandError, match="not a zone this topology defines"):
        _run_fixture(
            tmp_path,
            monkeypatch,
            [
                {
                    "key": "bad",
                    "name": "X",
                    "zones": [
                        {"id": "lakehouse", "position": {"x": 0, "y": 0}, "width": 10, "height": 10}
                    ],
                }
            ],
        )


def test_a_custom_zone_without_a_label_fails_the_load(tmp_path, monkeypatch):
    """Nothing else names it -- the topology has never heard of it."""
    with pytest.raises(CommandError, match="needs a label"):
        _run_fixture(
            tmp_path,
            monkeypatch,
            [
                {
                    "key": "bad",
                    "name": "X",
                    "zones": [
                        {
                            "id": "custom:theirs",
                            "position": {"x": 0, "y": 0},
                            "width": 10,
                            "height": 10,
                        }
                    ],
                }
            ],
        )


def test_a_declared_zone_without_geometry_fails_the_load(tmp_path, monkeypatch):
    """Declaring a zone *is* stating a layout; there is no size to fall back to."""
    with pytest.raises(CommandError, match="has no width"):
        _run_fixture(
            tmp_path,
            monkeypatch,
            [{"key": "bad", "name": "X", "zones": [{"id": "unify", "position": {"x": 0, "y": 0}}]}],
        )


def test_a_product_zones_label_comes_from_the_topology_not_the_fixture(tmp_path, monkeypatch):
    """One definition, so renaming Unify does not leave five templates disagreeing."""
    _run_fixture(
        tmp_path,
        monkeypatch,
        [
            {
                "key": "ok",
                "name": "X",
                "zones": [
                    {"id": "unify", "position": {"x": 0, "y": 0}, "width": 10, "height": 10}
                ],
            }
        ],
    )
    zone = Template.objects.get(key="ok").graph["zones"][0]
    defined = next(z for z in topology.ZONES if z["id"] == "unify")
    assert zone["label"] == defined["label"]
    assert zone["description"] == defined["description"]
    assert "custom" not in zone


def test_a_template_that_declares_no_zones_has_no_zones_key(tmp_path, monkeypatch):
    """
    An absent `zones` is what tells the canvas to draw the topology's own tree. An
    empty array would mean "this diagram has no zones" and open onto bare canvas.
    """
    _run_fixture(
        tmp_path,
        monkeypatch,
        [{"key": "ok", "name": "X", "nodes": [{"id": "pa", "kind": "profile_api", "synthetic": True}]}],
    )
    assert "zones" not in Template.objects.get(key="ok").graph


def test_prune_removes_templates_no_longer_in_the_fixture(tmp_path, monkeypatch, seeded):
    _run_fixture(
        tmp_path,
        monkeypatch,
        [{"key": "only-one", "name": "X", "nodes": [{"id": "pa", "kind": "profile_api", "synthetic": True}]}],
    )
    assert Template.objects.count() == 6  # the five seeded plus the new one

    call_command("seed_templates", "--prune", verbosity=0)
    assert [t.key for t in Template.objects.all()] == ["only-one"]


# --- The API surface --------------------------------------------------------

def test_template_list_omits_the_graph_but_keeps_the_count(auth_client, seeded):
    response = auth_client.get("/api/templates")
    assert response.status_code == 200
    item = next(i for i in response.data["items"] if i["key"] == "end-to-end-test")
    assert "graph" not in item
    assert item["placeholder_count"] == 5


def test_template_detail_returns_the_graph(auth_client, seeded):
    response = auth_client.get("/api/templates/end-to-end-test")
    assert response.status_code == 200
    assert len(response.data["graph"]["nodes"]) == 5


def test_templates_are_readable_without_a_session(client, seeded):
    """
    Deliberately open, and this test is the record of that decision.

    A template is a Segment reference architecture with no workspace field and no
    customer data, and it is the first thing a visitor with no token needs to see.
    """
    assert client.get("/api/templates").status_code == 200
    assert client.get("/api/templates/end-to-end-test").status_code == 200


# --- Save-time validation ---------------------------------------------------

def test_a_backwards_edge_is_no_longer_rejected(auth_client):
    """
    There is no adjacency table to check against any more: any component may connect
    to any other, in either direction. See ALLOWED_EDGES in topology.py, which still
    exists for template linting but not for a user-drawn edge.
    """
    response = auth_client.post(
        "/api/diagrams",
        {
            "name": "Backwards",
            "graph": {
                "nodes": [
                    {"id": "d", "kind": "destination", "zone": "connections"},
                    {"id": "s", "kind": "source", "zone": "connections"},
                ],
                "edges": [{"id": "e", "source": "d", "target": "s"}],
            },
        },
        format="json",
    )
    assert response.status_code == 201, response.data
    assert Diagram.objects.count() == 1


def test_saving_a_node_in_an_unexpected_zone_is_advised_not_rejected(auth_client):
    """
    This used to be a 400. It cannot be: a component may now be placed in any zone --
    identity resolution settings belong to Unify and Engage both -- so a diagram the
    canvas lets you draw has to be one the server lets you store. The topology's opinion
    comes back as advice on the same response.
    """
    response = auth_client.post(
        "/api/diagrams",
        {
            "name": "Misplaced",
            "graph": {"nodes": [{"id": "t", "kind": "computed_trait", "zone": "connections"}]},
        },
        format="json",
    )
    assert response.status_code == 201, response.data
    assert len(response.data["advisories"]) == 1
    assert "usually goes in Unify" in response.data["advisories"][0]


def test_a_component_on_the_segment_backdrop_is_not_advised_about(auth_client):
    """
    The Segment zone is a boundary, not a filing. It says "inside Segment" and does
    not claim to answer which product owns the thing -- which is the only honest
    answer for a component that belongs to two: Profiles Sync takes profiles from
    Unify and audience membership from Engage, and a Reverse ETL model spans the
    customer's warehouse and Segment's delivery. Advising on those was advice with
    nothing behind it, on a diagram the user had arranged on purpose.
    """
    response = auth_client.post(
        "/api/diagrams",
        {
            "name": "On the backdrop",
            "graph": {
                "nodes": [
                    {"id": "r", "kind": "reverse_etl_model", "zone": "segment"},
                    {"id": "p", "kind": "profile_sync", "zone": "segment"},
                ]
            },
        },
        format="json",
    )
    assert response.status_code == 201, response.data
    assert response.data["advisories"] == []


def test_the_backdrop_exemption_does_not_reach_the_product_zones(auth_client):
    """
    The assertion that keeps the exemption narrow. Without it, skipping `segment`
    could be widened to skip its children and the rule would be gone.
    """
    response = auth_client.post(
        "/api/diagrams",
        {
            "name": "Still misfiled",
            "graph": {"nodes": [{"id": "r", "kind": "reverse_etl_model", "zone": "engage"}]},
        },
        format="json",
    )
    assert response.status_code == 201, response.data
    assert "usually goes in Connections" in response.data["advisories"][0]


def test_the_shipped_full_pipeline_template_is_advised_about_less_than_it_was(seeded):
    """
    The template is hand-arranged, so some advice on it is expected and correct --
    Computed Trait really is drawn outside Unify. What must *not* be there any more is
    the pair on the Segment backdrop, which is where they belong.
    """
    template = Template.objects.get(key="end-to-end-full-pipeline")
    notes = placement_advisories(template.graph)
    assert not any("segment zone" in note for note in notes), notes


def test_a_component_with_no_zone_at_all_is_not_even_advised(auth_client):
    """
    The working area outside every zone. A component parked there is somewhere the user
    put it on purpose, so remarking on it would be noise on every save.
    """
    response = auth_client.post(
        "/api/diagrams",
        {
            "name": "Working area",
            "graph": {"nodes": [{"id": "t", "kind": "computed_trait", "zone": None}]},
        },
        format="json",
    )
    assert response.status_code == 201, response.data
    assert response.data["advisories"] == []


def test_a_correctly_placed_diagram_carries_no_advisories(auth_client):
    """
    The assertion that stops `advisories` becoming a field that always has something in
    it, which nobody would then read.
    """
    response = auth_client.post(
        "/api/diagrams",
        {
            "name": "Conventional",
            "graph": {"nodes": [{"id": "t", "kind": "computed_trait", "zone": "unify"}]},
        },
        format="json",
    )
    assert response.status_code == 201, response.data
    assert response.data["advisories"] == []


def test_a_component_in_a_custom_zone_is_exempt_from_the_zone_rule(auth_client):
    """
    A warehouse the customer runs as a reverse-ETL source is not inside Segment's
    pipeline, so asking which of Connections/Unify/Engage it belongs to has no
    answer.
    """
    response = auth_client.post(
        "/api/diagrams",
        {
            "name": "Outside Segment",
            "graph": {
                "zones": [
                    {"id": "custom:snowflake", "label": "Snowflake", "custom": True},
                ],
                "nodes": [{"id": "w", "kind": "warehouse", "zone": "custom:snowflake"}],
            },
        },
        format="json",
    )
    assert response.status_code == 201, response.data


def test_the_custom_zone_exemption_does_not_reach_the_product_zones(auth_client):
    """
    The assertion that proves the relaxation is narrow: a component in a product zone it
    does not belong to is still remarked on. Without this, `placement_advisories`
    returning nothing at all would pass every other test in this file -- and advice that
    is never given is indistinguishable from the rule having been deleted.
    """
    response = auth_client.post(
        "/api/diagrams",
        {
            "name": "Still misplaced",
            "graph": {
                "zones": [{"id": "custom:snowflake", "label": "Snowflake", "custom": True}],
                "nodes": [{"id": "w", "kind": "warehouse", "zone": "unify"}],
            },
        },
        format="json",
    )
    assert response.status_code == 201, response.data
    assert "usually goes in Connections" in response.data["advisories"][0]


def test_a_zone_is_only_exempt_when_it_says_it_is_custom():
    """A zone declared without the flag is a product zone, whatever its id."""
    notes = placement_advisories(
        {
            "zones": [{"id": "custom:snowflake", "label": "Snowflake"}],
            "nodes": [{"id": "w", "kind": "warehouse", "zone": "custom:snowflake"}],
            "edges": [],
        }
    )
    assert len(notes) == 1


def test_a_component_in_a_custom_zone_is_not_advised_about():
    """The exemption itself: Segment's zones have no jurisdiction outside Segment."""
    notes = placement_advisories(
        {
            "zones": [{"id": "custom:snowflake", "label": "Snowflake", "custom": True}],
            "nodes": [{"id": "w", "kind": "warehouse", "zone": "custom:snowflake"}],
            "edges": [],
        }
    )
    assert notes == []


def test_a_graph_with_no_zones_key_is_still_advised_about():
    """Diagrams saved before zones were part of the document have no `zones`."""
    notes = placement_advisories(
        {"nodes": [{"id": "t", "kind": "computed_trait", "zone": "connections"}], "edges": []}
    )
    assert len(notes) == 1


def test_a_custom_component_needs_no_backend_change(auth_client):
    """
    `custom` is deliberately not a topology kind, so it falls into the same
    unknown-kind tolerance that forward compatibility already relies on -- in a
    product zone as well as a custom one, and wired to a real component.
    """
    response = auth_client.post(
        "/api/diagrams",
        {
            "name": "Custom component",
            "graph": {
                "zones": [{"id": "custom:app", "label": "Their app", "custom": True}],
                "nodes": [
                    {"id": "c", "kind": "custom", "zone": "custom:app", "name": "Their API"},
                    {"id": "w", "kind": "custom", "zone": "connections", "name": "Snowflake"},
                    {"id": "s", "kind": "source", "zone": "connections"},
                ],
                "edges": [
                    {"id": "e1", "source": "c", "target": "s"},
                    {"id": "e2", "source": "s", "target": "w"},
                ],
            },
        },
        format="json",
    )
    assert response.status_code == 201, response.data


def test_advice_reads_through_react_flows_data_wrapper():
    """React Flow nests a node's payload under `data`; a template's is flat."""
    notes = placement_advisories(
        {
            "nodes": [{"id": "t", "data": {"kind": "computed_trait", "zone": "connections"}}],
            "edges": [],
        }
    )
    assert len(notes) == 1
    assert "usually goes in Unify" in notes[0]


def test_validation_reads_through_react_flows_data_wrapper():
    """The same wrapper, for the checks that are still refusals."""
    errors = validate_architecture(
        {
            "nodes": [{"id": "s", "data": {"kind": "source"}}],
            "edges": [{"id": "e", "source": "s", "target": "ghost"}],
        }
    )
    assert len(errors) == 1
    assert "not in the graph" in errors[0]


def test_an_unknown_kind_is_tolerated_on_save(auth_client):
    """
    Forward compatibility. Rejecting these would mean that adding a kind to
    topology.py makes every diagram saved from an older tab unsaveable.
    """
    response = auth_client.post(
        "/api/diagrams",
        {
            "name": "From the future",
            "graph": {
                "nodes": [
                    {"id": "a", "kind": "data_graph", "zone": "unify"},
                    {"id": "s", "kind": "source", "zone": "connections"},
                ],
                "edges": [{"id": "e", "source": "s", "target": "a"}],
            },
        },
        format="json",
    )
    assert response.status_code == 201


def test_a_dangling_edge_is_rejected(auth_client):
    response = auth_client.post(
        "/api/diagrams",
        {
            "name": "Dangling",
            "graph": {
                "nodes": [{"id": "s", "kind": "source", "zone": "connections"}],
                "edges": [{"id": "e", "source": "s", "target": "ghost"}],
            },
        },
        format="json",
    )
    assert response.status_code == 400
    assert "not in the graph" in str(response.data)


def test_a_valid_graph_round_trips_unchanged(auth_client, seeded):
    """Phase 5's done-when: open a template, save it, load it back identical."""
    template = auth_client.get("/api/templates/web-mobile-unify-engage").data

    created = auth_client.post(
        "/api/diagrams",
        {
            "name": "Acme architecture",
            "graph": {**template["graph"], "viewport": {"x": -120, "y": 40, "zoom": 0.75}},
            "source_template": template["key"],
        },
        format="json",
    )
    assert created.status_code == 201, created.data

    reloaded = auth_client.get(f"/api/diagrams/{created.data['id']}")
    assert reloaded.data["graph"] == created.data["graph"]
    assert reloaded.data["graph"]["viewport"] == {"x": -120, "y": 40, "zoom": 0.75}
    assert reloaded.data["node_count"] == 18
    assert reloaded.data["placeholder_count"] == 15
    assert reloaded.data["source_template"] == "web-mobile-unify-engage"


def test_a_hand_arranged_template_round_trips_with_its_layout(auth_client, seeded):
    """
    The case that was silently broken: a document's zones and positions surviving a
    save. A template whose whole point is the arrangement is worthless if opening it,
    saving it and reloading gives back a column layout and no regions outside Segment.
    """
    template = auth_client.get("/api/templates/end-to-end-full-pipeline").data

    created = auth_client.post(
        "/api/diagrams",
        {
            "name": "Acme end-to-end",
            "graph": template["graph"],
            "source_template": template["key"],
        },
        format="json",
    )
    assert created.status_code == 201, created.data

    reloaded = auth_client.get(f"/api/diagrams/{created.data['id']}").data["graph"]
    assert reloaded["zones"] == template["graph"]["zones"]
    assert [n["position"] for n in reloaded["nodes"]] == [
        n["position"] for n in template["graph"]["nodes"]
    ]
    # The two regions outside Segment, which cannot be regenerated from the topology.
    assert sum(1 for z in reloaded["zones"] if z.get("custom")) == 2
    # And the placement advice is given rather than the save being refused.
    assert created.data["advisories"]


def test_a_write_key_in_a_saved_graph_never_reaches_the_database(auth_client):
    """
    sanitize_graph is the last line of the obfuscation requirement: a client bug
    that puts a live key in node data must not persist it.
    """
    created = auth_client.post(
        "/api/diagrams",
        {
            "name": "Leaky",
            "graph": {
                "nodes": [
                    {
                        "id": "s",
                        "kind": "source",
                        "zone": "connections",
                        "writeKey": "live_key_abcd1234",
                        "writeKeyMasked": "••••••••1234",
                    }
                ]
            },
        },
        format="json",
    )
    assert created.status_code == 201

    stored = Diagram.objects.get(pk=created.data["id"]).graph
    assert "writeKey" not in stored["nodes"][0]
    assert stored["nodes"][0]["writeKeyMasked"] == "••••••••1234"
    assert "live_key_abcd1234" not in json.dumps(stored)


def test_a_component_in_a_second_copy_of_a_zone_is_not_advised_about(auth_client):
    """
    One canvas, two diagrams side by side.

    A divider lets the same zone appear more than once, and the copy needs an id of its
    own -- two zones sharing one would collide, since `zones` is keyed by id and a
    component stores a single `zone` string. So the copy is `connections~2`, and the
    rules have to keep being Connections' rules.

    Without `zone_product`, every component in the copy earned "usually goes in
    Connections" on every single save: advice that is not only wrong but unfixable, since
    the component *is* in Connections and there is nowhere else to put it.
    """
    response = auth_client.post(
        "/api/diagrams",
        {
            "name": "Before and after",
            "graph": {
                "nodes": [
                    {"id": "a", "kind": "source", "zone": "connections"},
                    {"id": "b", "kind": "source", "zone": "connections~2"},
                ],
                "zones": [
                    {"id": "connections", "label": "Connections"},
                    {"id": "connections~2", "label": "Connections (2)"},
                ],
            },
        },
        format="json",
    )
    assert response.status_code == 201, response.data
    assert response.data["advisories"] == []


def test_a_misplaced_component_in_a_copied_zone_is_still_advised_about(auth_client):
    """
    The assertion that keeps the above narrow: a copy is exempt from *nothing*. It is
    Connections, so what does not belong in Connections does not belong in it either --
    and the message names the product rather than the raw copy id, because "connections~2"
    is an implementation detail the reader never chose.
    """
    response = auth_client.post(
        "/api/diagrams",
        {
            "name": "Still misfiled",
            "graph": {
                "nodes": [{"id": "t", "kind": "computed_trait", "zone": "connections~2"}],
                "zones": [{"id": "connections~2", "label": "Connections (2)"}],
            },
        },
        format="json",
    )
    assert response.status_code == 201, response.data
    assert len(response.data["advisories"]) == 1
    assert "usually goes in Unify" in response.data["advisories"][0]


def test_a_divider_exempts_its_contents_like_any_region_the_user_drew(auth_client):
    """
    A divider is stored as a custom zone -- it *is* a region the user drew -- so anything
    dropped straight into a section rather than into a zone inside it is outside Segment's
    filing system, exactly like something in a box drawn around the customer's own app.
    """
    response = auth_client.post(
        "/api/diagrams",
        {
            "name": "Divided",
            "graph": {
                "nodes": [{"id": "t", "kind": "computed_trait", "zone": "custom:zone:ab12"}],
                "zones": [
                    {
                        "id": "custom:zone:ab12",
                        "label": "Divider",
                        "custom": True,
                        "frame": {"axis": "vertical", "splitX": 0.5},
                    }
                ],
            },
        },
        format="json",
    )
    assert response.status_code == 201, response.data
    assert response.data["advisories"] == []
