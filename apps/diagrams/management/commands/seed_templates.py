"""
Load the built-in reference architectures from fixtures/templates.json.

Not `loaddata`. The fixture deliberately does not repeat what is already defined
elsewhere -- a node declares its `kind` and this command derives the zone from
topology.py and the docs URL from deeplinks.py. So a template can never drift
into claiming a computed trait belongs in Connections, and correcting a docs URL
in one file re-seeds correct templates on the next deploy.

It also validates. A fixture that encodes an illegal edge would produce a diagram
the canvas refuses to draw and the API refuses to save, which is a confusing thing
to hand somebody as a starting point -- so this fails loudly at seed time instead.

Two shapes of template, and the difference is whether the fixture states a layout.
Most say nothing about zones or positions: the canvas draws the full zone tree from
the topology and lays the components out in columns, which is the right answer for a
reference architecture whose point is the shape of the pipeline. One that *does*
declare `zones` is a hand-arranged diagram -- a specific drawing somebody made,
sub-zones and all -- and it is reproduced as drawn, including a component sitting
somewhere other than its kind's usual zone. Both are honest templates; only the
second can express a region outside Segment, since the topology has never heard of
the customer's own warehouse.

Idempotent: run it on every deploy.
"""

import json
from pathlib import Path

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.segmentapi import deeplinks, topology

from ...models import Template

FIXTURE = Path(__file__).resolve().parents[2] / "fixtures" / "templates.json"

# Kinds with no topology entry, so no zone and no adjacency table. Mirrors
# RULE_FREE_KINDS in frontend/src/canvas/rules.js and the tolerance
# validate_architecture already extends to a kind it does not recognise: a custom
# component stands for something the customer runs themselves, and there is nothing
# for Segment's rules to say about it.
RULE_FREE_KINDS = frozenset({"custom"})

# A zone a fixture may declare that the topology does not define. Anything outside
# Segment -- their app, a warehouse they own outright -- has no id we could derive.
CUSTOM_ZONE_PREFIX = "custom:"


class Command(BaseCommand):
    help = "Seed the built-in reference architecture templates."

    def add_arguments(self, parser):
        parser.add_argument(
            "--check",
            action="store_true",
            help="Validate the fixture and report, without writing to the database.",
        )
        parser.add_argument(
            "--prune",
            action="store_true",
            help="Delete builtin templates whose key is no longer in the fixture.",
        )

    def handle(self, *args, **options):
        raw = self._read()
        seen = []

        for entry in raw:
            key = entry.get("key")
            if not key:
                raise CommandError("Every template needs a key.")
            graph = self._build_graph(key, entry)
            seen.append(key)

            placeholders = sum(1 for n in graph["nodes"] if n["bound"] is False and n["bindable"])
            summary = (
                f"{key}: {len(graph['nodes'])} nodes, {len(graph['edges'])} edges, "
                f"{placeholders} to bind"
            )

            if options["check"]:
                self.stdout.write(f"  ok   {summary}")
                continue

            _, created = Template.objects.update_or_create(
                key=key,
                defaults={
                    "name": entry.get("name", key),
                    "description": entry.get("description", ""),
                    "category": entry.get("category", ""),
                    "graph": graph,
                    "is_builtin": True,
                    "sort_order": entry.get("sort_order", 0),
                },
            )
            self.stdout.write(f"  {'new ' if created else 'updated'} {summary}")

        if options["prune"] and not options["check"]:
            stale = Template.objects.filter(is_builtin=True).exclude(key__in=seen)
            for template in stale:
                self.stdout.write(self.style.WARNING(f"  removed {template.key}"))
            stale.delete()

        verb = "Validated" if options["check"] else "Seeded"
        self.stdout.write(self.style.SUCCESS(f"{verb} {len(raw)} templates."))

    def _read(self) -> list[dict]:
        if not FIXTURE.exists():
            raise CommandError(f"Fixture not found: {FIXTURE}")
        try:
            data = json.loads(FIXTURE.read_text())
        except json.JSONDecodeError as exc:
            raise CommandError(f"{FIXTURE.name} is not valid JSON: {exc}") from exc
        if not isinstance(data, list):
            raise CommandError(f"{FIXTURE.name} must contain a list of templates.")
        return data

    def _build_graph(self, key: str, entry: dict) -> dict:
        zones = [
            self._build_zone(key, raw, index) for index, raw in enumerate(entry.get("zones", []))
        ]
        zone_ids = {zone["id"] for zone in zones}

        nodes_by_id: dict[str, dict] = {}
        nodes = []

        for raw in entry.get("nodes", []):
            node = self._build_node(key, raw, zone_ids)
            if node["id"] in nodes_by_id:
                raise CommandError(f"{key}: duplicate node id {node['id']!r}.")
            nodes_by_id[node["id"]] = node
            nodes.append(node)

        # A template that states its own zones is a drawing somebody made; see this
        # module's docstring. That is also what decides whether an off-table edge is a
        # mistake or a liberty -- see `_build_edge`.
        hand_arranged = bool(zones)
        edges = [
            self._build_edge(key, raw, nodes_by_id, hand_arranged=hand_arranged)
            for raw in entry.get("edges", [])
        ]

        graph = {"nodes": nodes, "edges": edges}
        # Omitted rather than written as `[]` when the fixture declares none. An
        # absent `zones` is what tells buildLayout to draw the topology's own tree;
        # an empty array means "this diagram has no zones", which would open the four
        # reference architectures onto bare canvas.
        if zones:
            graph["zones"] = zones
        # Saved walkthroughs, passed through as authored.
        #
        # Nothing is derived here, unlike a node or an edge, because a path is not a claim
        # about Segment's architecture -- it is a claim about which story this diagram is
        # for, and there is no second source of truth to check it against. What it *is*
        # checked for is dangling references: a path naming a component the template does
        # not contain would start a walkthrough nowhere, and silently.
        scenarios = [
            self._build_scenario(key, raw, nodes_by_id) for raw in entry.get("scenarios", [])
        ]
        if scenarios:
            graph["scenarios"] = scenarios
        return graph

    def _build_scenario(self, key: str, raw: dict, nodes_by_id: dict[str, dict]) -> dict:
        """A saved walkthrough, checked only for references it could not resolve."""
        scenario_id = raw.get("id")
        if not scenario_id:
            raise CommandError(f"{key}: every scenario needs an id. Got {raw!r}.")

        source_id = raw.get("sourceId")
        if source_id and source_id not in nodes_by_id:
            raise CommandError(
                f"{key}: scenario {scenario_id!r} starts at {source_id!r}, which this "
                f"template does not contain -- so the walkthrough would begin nowhere."
            )

        # `excluded` and `disabled` name components to step over or stop at. A stale id in
        # either is inert rather than broken, but it is still a fixture that does not mean
        # what it says, so it fails here rather than going out in a shipped template.
        for field in ("excluded", "disabled", "revisit"):
            for node_id in raw.get(field) or []:
                if node_id not in nodes_by_id:
                    raise CommandError(
                        f"{key}: scenario {scenario_id!r} lists unknown node {node_id!r} "
                        f"under {field!r}."
                    )
        return dict(raw)

    def _build_zone(self, key: str, raw: dict, index: int) -> dict:
        """
        A declared zone: one of the topology's, or a region outside Segment.

        A product zone's label, description and order come from topology.py rather than
        the fixture, for the same reason a node's zone does -- one definition, so
        renaming Unify's description does not leave five templates disagreeing with the
        palette. A custom zone has no such source and states its own.

        `order` is paint order among siblings, so a custom zone that does not state one
        is put after every product zone: it is a region the customer drew, and drawing
        it behind Segment would hide it.
        """
        zone_id = raw.get("id")
        if not zone_id:
            raise CommandError(f"{key}: every zone needs an id. Got {raw!r}.")

        custom = bool(raw.get("custom")) or zone_id.startswith(CUSTOM_ZONE_PREFIX)
        known = {zone["id"]: zone for zone in topology.ZONES}
        if not custom and zone_id not in known:
            raise CommandError(
                f"{key}: zone {zone_id!r} is not a zone this topology defines. Either "
                f"use one from apps/segmentapi/topology.py or mark it `custom` and give "
                f"it a {CUSTOM_ZONE_PREFIX!r} id."
            )
        if custom and not raw.get("label"):
            raise CommandError(
                f"{key}: custom zone {zone_id!r} needs a label -- nothing else names it."
            )

        for field in ("position", "width", "height"):
            if field not in raw:
                raise CommandError(
                    f"{key}: zone {zone_id!r} has no {field}. A declared zone is a "
                    f"hand-arranged one, so its geometry is the point of declaring it."
                )

        defined = known.get(zone_id, {})
        after_product_zones = max(zone["order"] for zone in topology.ZONES) + 1
        return {
            **{k: v for k, v in raw.items() if k != "custom"},
            "id": zone_id,
            "label": raw.get("label") or defined.get("label", zone_id),
            "description": raw.get("description") or defined.get("description", ""),
            "order": defined.get("order", raw.get("order", after_product_zones + index)),
            **({"parent": raw["parent"]} if raw.get("parent") else {}),
            **({"custom": True} if custom else {}),
            "docsUrl": deeplinks.zone_docs_url(zone_id),
        }

    def _build_node(self, key: str, raw: dict, zone_ids: set[str] | None = None) -> dict:
        node_id = raw.get("id")
        kind = raw.get("kind")
        if not node_id or not kind:
            raise CommandError(f"{key}: every node needs an id and a kind. Got {raw!r}.")
        if kind not in topology.KINDS and kind not in RULE_FREE_KINDS:
            raise CommandError(
                f"{key}: node {node_id!r} has unknown kind {kind!r}. "
                f"Known kinds are in apps/segmentapi/topology.py."
            )

        # Synthetic components (the core, identity resolution, the Profile API) have
        # no Segment resource behind them, so they arrive complete rather than as
        # something to bind.
        synthetic = bool(raw.get("synthetic"))
        bound = bool(raw.get("bound", synthetic))

        # A journey cannot be bound -- there is no Journeys API to bind it to. It
        # still renders dashed, which reads correctly as "drawn by hand, unverified",
        # but it must not be counted in "N placeholders to bind" or that count could
        # never reach zero.
        bindable = bool(raw.get("bindable", not bound))
        if bindable and not topology.KINDS.get(kind, {}).get("api", False):
            bindable = False

        if bindable and not raw.get("binds"):
            raise CommandError(
                f"{key}: node {node_id!r} is bindable but has no `binds` hint, so the "
                f"binding panel would have nothing to offer."
            )

        node = {
            **{k: v for k, v in raw.items() if k not in {"binds"}},
            "id": node_id,
            "kind": kind,
            "zone": self._zone_for(key, raw, kind, zone_ids or set()),
            "name": raw.get("name", kind),
            "description": raw.get("description", ""),
            "bound": bound,
            "bindable": bindable,
            "synthetic": synthetic,
            "docsUrl": deeplinks.docs_url(kind),
            # A placeholder has no workspace resource yet, so it has no workspace
            # link. Binding fills both of these from the real component.
            "workspaceUrl": None,
            "linkVerified": deeplinks.is_verified(kind),
        }
        if raw.get("binds"):
            node["binds"] = self._build_binds(key, node_id, raw["binds"], kind)
        return node

    def _zone_for(self, key: str, raw: dict, kind: str, zone_ids: set[str]) -> str | None:
        """
        Which zone the node sits in: derived from its kind, or stated by the fixture.

        Derived is the default and the one to prefer -- it is what stops a template
        claiming a computed trait belongs in Connections. A fixture may override it
        only by naming a zone it also declared, which is the case a hand-arranged
        diagram needs: a component may legitimately sit somewhere other than its
        kind's usual zone, and the canvas now says so as advice rather than refusing
        it (see placement_advisories). Naming a zone the fixture did not declare is
        always a mistake, because nothing would draw it.
        """
        if "zone" not in raw:
            return topology.expected_zone(kind)

        stated = raw["zone"]
        if stated is None:
            # The working area outside every zone. A real answer, not a missing one.
            return None
        if stated not in zone_ids:
            raise CommandError(
                f"{key}: node {raw['id']!r} is placed in zone {stated!r}, which this "
                f"template does not declare -- so nothing would draw it. Add it to "
                f"`zones` or drop the override."
            )
        return stated

    def _build_binds(self, key: str, node_id: str, binds: dict, kind: str) -> dict:
        bind_kind = binds.get("kind", kind)
        if bind_kind != kind:
            raise CommandError(
                f"{key}: node {node_id!r} is a {kind} but binds to a {bind_kind}. "
                f"Binding must not change a node's kind -- its zone and its legal "
                f"connections depend on it."
            )
        return {**binds, "kind": kind}

    def _build_edge(
        self, key: str, raw: dict, nodes_by_id: dict[str, dict], hand_arranged: bool = False
    ) -> dict:
        source, target = raw.get("source"), raw.get("target")
        for end in (source, target):
            if end not in nodes_by_id:
                raise CommandError(f"{key}: edge references unknown node {end!r}.")

        from_kind = nodes_by_id[source]["kind"]
        to_kind = nodes_by_id[target]["kind"]
        # A rule-free kind has no row in the adjacency table and no business having
        # one -- the table would say "nothing may connect to the customer's own
        # service", which is false and is the reason `custom` is not a topology kind.
        rule_free = {from_kind, to_kind} & RULE_FREE_KINDS
        if not rule_free and not topology.is_valid_edge(from_kind, to_kind):
            # Advice for a hand-arranged template, a refusal for a generated one, and the
            # split is the same one `placement_advisories` already draws for zones.
            #
            # A template that states no layout is a claim about the shape of the pipeline,
            # and an off-table edge in one is straightforwardly a mistake. A hand-arranged
            # template is a drawing somebody made, and a drawing legitimately contains
            # edges that are not data flow: "this is the same warehouse at both ends",
            # "this destination forwards to their own system". validators.py already
            # decided this for user-drawn edges -- ALLOWED_EDGES is "only for linting the
            # bundled templates" -- and refusing here was the last place that made a
            # diagram the canvas accepts unshippable as the template it came from.
            #
            # Still said out loud, every seed, because the alternative is that a genuine
            # gap in the table (two were found this way) goes unnoticed forever.
            complaint = (
                f"{key}: {source} -> {target} is not in the adjacency table "
                f"({from_kind} -> {to_kind})."
            )
            if not hand_arranged:
                raise CommandError(
                    f"{complaint} The canvas would let a user draw it, but a template that "
                    f"declares no layout is a reference architecture -- it should not be "
                    f"the thing that teaches somebody a connection Segment does not make. "
                    f"If the edge is deliberate, the template should state its own zones."
                )
            self.stdout.write(self.style.WARNING(f"  warn {complaint}"))

        edge = {
            "id": raw.get("id") or f"{source}->{target}",
            "source": source,
            "target": target,
            "phase": topology.EDGE_PHASE.get(to_kind) or topology.EDGE_PHASE.get(from_kind),
            # Not read from a workspace, so deletable -- unlike a discovered edge,
            # which is a fact about the customer's setup.
            "discovered": False,
        }
        # Which side of each component the line meets, where along that side, and any
        # corners it was dragged through. Carried rather than derived, because there is
        # nothing to derive them from: they are the difference between the drawing somebody
        # made and a default route between two boxes. Dropping them -- which this did until
        # a hand-arranged template with 19 anchored ends and 2 routed edges was added --
        # loses the arrangement silently, leaving a template that validates, seeds, opens,
        # and looks nothing like the diagram it was made from.
        for field in ("sourceHandle", "targetHandle", "sourceAnchor", "targetAnchor", "waypoints"):
            if raw.get(field):
                edge[field] = raw[field]
        return edge
