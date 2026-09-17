"""
What the browser is allowed to know about a person.

Mirrors `apps/auth_workspace/serializers.py`: narrow, explicit field lists, and
nothing sensitive reachable by accident. There is no credential here to leak, but
`google_sub` is still omitted -- it is an identifier for Google's benefit, not the
browser's, and the frontend has no use for it.
"""

from rest_framework import serializers

from .admission import normalize_email
from .models import Account, Invitation


class AccountSerializer(serializers.ModelSerializer):
    avatarUrl = serializers.CharField(source="avatar_url", read_only=True)

    class Meta:
        model = Account
        fields = ["email", "name", "avatarUrl"]
        read_only_fields = fields


class InvitationSerializer(serializers.ModelSerializer):
    invitedBy = serializers.CharField(source="invited_by.email", default=None, read_only=True)
    createdAt = serializers.DateTimeField(source="created_at", read_only=True)
    acceptedAt = serializers.DateTimeField(source="accepted_at", read_only=True)
    pending = serializers.BooleanField(source="is_pending", read_only=True)

    class Meta:
        model = Invitation
        fields = ["id", "email", "invitedBy", "createdAt", "acceptedAt", "pending"]
        read_only_fields = fields


class CreateInvitationSerializer(serializers.Serializer):
    """Input for POST /api/invitations."""

    email = serializers.EmailField(max_length=254, trim_whitespace=True)

    def validate_email(self, value):
        # Normalized here as well as in `admission.invite`, so that the value echoed
        # back in the response is the one that was actually stored.
        return normalize_email(value)
