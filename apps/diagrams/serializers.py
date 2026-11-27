"""
Diagram and template serializers.

`workspace_id` is read-only everywhere: it is the authorization boundary and is
always taken from the session, never from the request body. A writable
workspace_id would let any caller with a valid token write into another
workspace's diagrams.
"""

import uuid

from rest_framework import serializers

from apps.auth_workspace.models import RememberedConnection

from .models import (
    MAX_GRAPH_DEPTH,
    Diagram,
    Template,
    carries_workspace_identity,
    graph_depth,
    has_bound_nodes,
)
from .validators import placement_advisories, placement_notes, validate_architecture


class TemplateSerializer(serializers.ModelSerializer):
    placeholder_count = serializers.IntegerField(read_only=True)
    owner = serializers.SerializerMethodField()
    locked_workspace_id = serializers.CharField(read_only=True)

    def get_owner(self, obj) -> str:
        """"builtin", "me" or "shared" -- from the reader's side, never an account id."""
        if obj.is_builtin:
            return "builtin"
        principal = self.context.get("principal")
        if principal is not None and obj.owner_id and obj.owner_id == getattr(principal, "account_id", None):
            return "me"
        return "shared"

    class Meta:
        model = Template
        fields = [
            "key",
            "name",
            "description",
            "category",
            "graph",
            "is_builtin",
            "placeholder_count",
            "owner",
            "shared_with_company",
            "locked_workspace_id",
            "published",
        ]
        read_only_fields = fields


class TemplateListSerializer(TemplateSerializer):
    """Index view: the graph can be tens of KB, and the list does not need it."""

    class Meta(TemplateSerializer.Meta):
        fields = [
            "key",
            "name",
            "description",
            "category",
            "is_builtin",
            "placeholder_count",
            "owner",
            "shared_with_company",
            "locked_workspace_id",
            "published",
        ]
        read_only_fields = fields


class TemplateCreateSerializer(serializers.Serializer):
    """
    Input for `POST /api/templates`: a diagram, saved so it can be started from again.

    `locked_workspace_id` is not an input. Whether a template is generic or belongs to one
    workspace is a fact about its graph -- does it still carry that workspace's ids and links --
    and a client that could say "generic" over a graph full of them would be publishing a
    workspace's data to everyone who can see the template.
    """

    name = serializers.CharField(max_length=255, trim_whitespace=True)
    description = serializers.CharField(required=False, allow_blank=True, max_length=10_000)
    category = serializers.CharField(required=False, allow_blank=True, max_length=64)
    graph = serializers.JSONField()
    shared_with_company = serializers.BooleanField(required=False, default=False)

    def validate_graph(self, value):
        # The same rules a saved diagram is held to.
        return DiagramSerializer().validate_graph(value)

    def create(self, validated_data):
        principal = self.context["principal"]
        graph = validated_data["graph"]
        locked = ""
        if carries_workspace_identity(graph):
            locked = principal.workspace_id if principal.has_token else ""
            if not locked or locked not in principal.connected_workspace_ids:
                raise serializers.ValidationError(
                    {
                        "graph": (
                            "This diagram still carries a workspace's own data. Connect that "
                            "workspace in this tab to keep it, or remove it first."
                        )
                    }
                )
        return Template.objects.create(
            key=f"u-{uuid.uuid4().hex[:24]}",
            name=validated_data["name"],
            description=validated_data.get("description", ""),
            category=validated_data.get("category") or "My templates",
            graph=graph,
            is_builtin=False,
            owner=principal.account,
            shared_with_company=validated_data.get("shared_with_company", False),
            locked_workspace_id=locked,
            sort_order=1000,
        )


class DiagramSerializer(serializers.ModelSerializer):
    node_count = serializers.IntegerField(read_only=True)
    placeholder_count = serializers.IntegerField(read_only=True)
    advisories = serializers.SerializerMethodField()
    advisory_nodes = serializers.SerializerMethodField()
    owner = serializers.SerializerMethodField()
    workspace = serializers.SerializerMethodField()

    class Meta:
        model = Diagram
        fields = [
            "id",
            "name",
            "description",
            "graph",
            "source_template",
            "group_name",
            # Writable: the one lever someone has over who else can read this.
            "shared_with_workspace",
            # Read-only, and still never accepted from a body -- see the module
            # docstring. It is set from the session on create, and on update only when
            # sharing is switched on for a diagram drawn before a workspace existed.
            "workspace_id",
            # Where its bound components came from, and whether this account can get
            # back there -- see `get_workspace`.
            "workspace",
            "owner",
            "node_count",
            "placeholder_count",
            "advisories",
            "advisory_nodes",
            "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "id",
            "workspace_id",
            "workspace",
            "owner",
            "node_count",
            "placeholder_count",
            "advisories",
            "advisory_nodes",
            "created_at",
            "updated_at",
        ]

    def validate_group_name(self, value):
        return " ".join((value or "").split())[:80]

    def get_advisories(self, obj) -> list[str]:
        """
        Notes about placement, on the saved graph rather than the submitted one.

        Read off the instance on purpose: `Diagram.save` runs `sanitize_graph`, so what
        comes back is what was actually stored. Advice computed from the request body
        could describe a node the model rewrote.
        """
        return placement_advisories(obj.graph or {})

    def get_advisory_nodes(self, obj) -> list[str]:
        """
        The component each note is about, so the canvas can point at it.

        A separate field rather than a change to `advisories`: the messages are what a
        log line and a CLI want, and turning that field into a list of objects would
        make every existing reader unwrap something to get back what it had. Ordered
        with `advisories` and the same length, the truncation line included, so a
        reader can zip them without checking.
        """
        return [note["nodeId"] for note in placement_notes(obj.graph or {})]

    def validate_graph(self, value):
        if not isinstance(value, dict):
            raise serializers.ValidationError("graph must be an object.")
        if graph_depth(value) > MAX_GRAPH_DEPTH:
            raise serializers.ValidationError("graph is nested too deeply.")
        for key in ("nodes", "edges"):
            if key in value and not isinstance(value[key], list):
                raise serializers.ValidationError(f"graph.{key} must be an array.")

        errors = validate_architecture(value)
        if errors:
            # Named, not counted. The canvas enforces the same rules live, so a
            # rejection here means the two disagree, and the message has to be
            # specific enough to find out which one is wrong.
            #
            # Zone placement is deliberately not among these -- it comes back as
            # `advisories` instead. A component in an unexpected zone used to fail the
            # save outright, which meant a diagram the canvas let you draw could not be
            # stored.
            raise serializers.ValidationError(errors)
        return value

    def get_owner(self, obj) -> str:
        """
        Whose this is, from the reader's point of view: "me", "shared" or "unclaimed".

        A label rather than an id, because the id would be an account uuid the browser
        has no use for -- what the open dialog needs to know is whether to offer Delete
        and whether to badge the row.
        """
        principal = self.context.get("principal")
        if principal is None:
            return "unclaimed"
        if principal.account_id and obj.owner_id == principal.account_id:
            return "me"
        if principal.anon_scope and obj.anon_scope == principal.anon_scope:
            return "me"
        if obj.owner_id is None and not obj.anon_scope:
            # Predates accounts: reachable by whoever holds a credential for its
            # workspace, and still editable by them. `claim_diagrams` resolves these.
            return "unclaimed"
        return "shared"

    def get_workspace(self, obj) -> dict | None:
        """
        The workspace this diagram's bound components came from, as the reader can reach it.

        `{id, name, slug, region, connected, remembered}`. `connected` is whether the
        current session holds it; `remembered` is whether this account has a stored
        connection the SPA can resume with `POST /api/session/resume`. That pair is what
        lets reopening a diagram days later put the workspace back without asking for
        the token again. Names come from the remembered row because the diagram stores
        only the id.

        Null for a diagram about no workspace.
        """
        if not obj.workspace_id:
            return None
        principal = self.context.get("principal")
        connected = obj.workspace_id in (getattr(principal, "connected_workspace_ids", None) or [])
        remembered = RememberedConnection.lookup(
            getattr(principal, "account", None), obj.workspace_id
        )
        source = principal.session if connected else remembered
        return {
            "id": obj.workspace_id,
            "name": getattr(source, "workspace_name", "") or "",
            "slug": getattr(source, "workspace_slug", "") or "",
            "region": getattr(source, "region", "") or "",
            "connected": connected,
            "remembered": remembered is not None,
        }

    def validate_shared_with_workspace(self, value):
        """
        Sharing needs a workspace to share *with*, and a credential proving you reach it.

        Without the credential check anyone could publish a diagram into a workspace
        they cannot read, which would put it in front of that workspace's real users.
        """
        if not value:
            return value

        principal = self.context.get("principal")
        reachable = getattr(principal, "connected_workspace_ids", None) or []
        target = (self.instance.workspace_id if self.instance else "") or (
            principal.workspace_id if principal else ""
        )
        if not target:
            raise serializers.ValidationError(
                "This diagram is not about a workspace yet. Connect the workspace it "
                "describes, then share it."
            )
        if target not in reachable:
            raise serializers.ValidationError(
                "You do not hold a credential for the workspace this diagram belongs to."
            )
        return value

    def create(self, validated_data):
        # Ownership comes from the session, never the payload -- the same rule
        # `workspace_id` has always followed. Model.save() also runs sanitize_graph, so
        # secrets cannot be persisted even if a client sends them.
        principal = self.context["principal"]
        validated_data["owner"] = principal.account
        # Only when there is no account: two owners would make `claim_for_account`
        # ambiguous, and a signed-in person's diagram should not also be reachable by
        # whoever later holds this cookie.
        validated_data["anon_scope"] = "" if principal.account_id else principal.anon_scope
        validated_data["workspace_id"] = principal.workspace_id
        return super().create(validated_data)

    def update(self, instance, validated_data):
        # Stamp the subject when sharing is switched on for something drawn before a
        # workspace was connected. `workspace_id` stays unwritable from the body, so
        # this is the only way it can ever be set after creation.
        principal = self.context["principal"]
        if validated_data.get("shared_with_workspace") and not instance.workspace_id:
            validated_data["workspace_id"] = principal.workspace_id
        # And when it is first saved with components bound from a connected workspace.
        # Without this, a diagram created before connecting stayed about no workspace
        # for ever, however many real components were bound into it -- and the next
        # session had nothing to say which connection to resume when it was reopened.
        graph = validated_data.get("graph")
        if (
            not instance.workspace_id
            and getattr(principal, "has_token", False)
            and graph is not None
            and has_bound_nodes(graph)
        ):
            validated_data["workspace_id"] = principal.workspace_id
        return super().update(instance, validated_data)


class DiagramListSerializer(DiagramSerializer):
    class Meta(DiagramSerializer.Meta):
        fields = [
            "id",
            "name",
            "description",
            "source_template",
            "group_name",
            "shared_with_workspace",
            "workspace_id",
            # So the open dialog can badge someone else's diagram and disable Delete
            # on it rather than offering an action that 403s.
            "owner",
            "node_count",
            # Cheap here (the graph is already loaded) and the open dialog needs it
            # to say "3 placeholders left to bind" without fetching every graph.
            "placeholder_count",
            "created_at",
            "updated_at",
        ]
