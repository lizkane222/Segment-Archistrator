"""
Nuance read and write shapes.

Two serializers rather than one with `read_only` fields, because they answer different
questions: a reader gets what was written and when, and a submitter is only allowed to
supply three fields. `status` in particular must not be writable -- a submission that
could arrive as `published` would walk straight past the one moderation lever this table
has.
"""

from rest_framework import serializers

from .models import Nuance

# Long enough for the paragraph that explains a product gap, short enough that the
# field stays a note. There is no attribution on this table, so there is also no
# per-submitter throttle to fall back on: the cap is doing real work here, not
# just guarding the column.
MAX_BODY = 2000


class NuanceSerializer(serializers.ModelSerializer):
    createdAt = serializers.DateTimeField(source="created_at", read_only=True)

    class Meta:
        model = Nuance
        fields = ["id", "kind", "slug", "body", "status", "createdAt"]
        read_only_fields = fields


class NuanceSubmitSerializer(serializers.ModelSerializer):
    class Meta:
        model = Nuance
        fields = ["kind", "slug", "body"]

    def validate_kind(self, value: str) -> str:
        if value not in Nuance.known_kinds():
            raise serializers.ValidationError(
                f"'{value}' is not a component kind this canvas knows about."
            )
        return value

    def validate_body(self, value: str) -> str:
        body = value.strip()
        if not body:
            raise serializers.ValidationError("Write the nuance before submitting it.")
        if len(body) > MAX_BODY:
            raise serializers.ValidationError(
                f"Keep it under {MAX_BODY} characters — this is a note, not a runbook."
            )
        return body
