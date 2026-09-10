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

    class Meta:
        model = Diagram
        fields = [
            "id",
            "name",
            "description",
            "graph",
            "source_template",
            "node_count",
            "placeholder_count",
            "advisories",
            "advisory_nodes",
            "created_at",
            "updated_at",
        ]
        read_only_fields = [
            "id",
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

    def create(self, validated_data):
        # From the session, never the payload. Model.save() also runs
        # sanitize_graph, so secrets cannot be persisted even if a client sends them.
        validated_data["workspace_id"] = self.context["workspace_id"]
        return super().create(validated_data)


class DiagramListSerializer(DiagramSerializer):
    class Meta(DiagramSerializer.Meta):
        fields = [
            "id",
            "name",
            "description",
            "source_template",
            "node_count",
            # Cheap here (the graph is already loaded) and the open dialog needs it
            # to say "3 placeholders left to bind" without fetching every graph.
            "placeholder_count",
            "created_at",
            "updated_at",
        ]
