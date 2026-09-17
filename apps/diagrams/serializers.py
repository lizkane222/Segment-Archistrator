"""
Diagram and template serializers.

`workspace_id` is read-only everywhere: it is the authorization boundary and is
always taken from the session, never from the request body. A writable
workspace_id would let any caller with a valid token write into another
workspace's diagrams.
"""

from rest_framework import serializers

from .models import Diagram, Template
from .validators import placement_advisories, placement_notes, validate_architecture


class TemplateSerializer(serializers.ModelSerializer):
    placeholder_count = serializers.IntegerField(read_only=True)

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
        ]
        read_only_fields = fields


class DiagramSerializer(serializers.ModelSerializer):
    node_count = serializers.IntegerField(read_only=True)
    placeholder_count = serializers.IntegerField(read_only=True)
    advisories = serializers.SerializerMethodField()
    advisory_nodes = serializers.SerializerMethodField()
    owner = serializers.SerializerMethodField()

    class Meta:
        model = Diagram
        fields = [
            "id",
            "name",
            "description",
            "graph",
            "source_template",
            # Writable: the one lever someone has over who else can read this.
            "shared_with_workspace",
            # Read-only, and still never accepted from a body -- see the module
            # docstring. It is set from the session on create, and on update only when
            # sharing is switched on for a diagram drawn before a workspace existed.
            "workspace_id",
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
            "owner",
            "node_count",
            "placeholder_count",
            "advisories",
            "advisory_nodes",
            "created_at",
            "updated_at",
        ]

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
        if validated_data.get("shared_with_workspace") and not instance.workspace_id:
            principal = self.context["principal"]
            validated_data["workspace_id"] = principal.workspace_id
        return super().update(instance, validated_data)


class DiagramListSerializer(DiagramSerializer):
    class Meta(DiagramSerializer.Meta):
        fields = [
            "id",
            "name",
            "description",
            "source_template",
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
