from rest_framework import serializers

from .models import WorkspaceSession


class StartSessionSerializer(serializers.Serializer):
    """Input for POST /api/session."""

    token = serializers.CharField(
        write_only=True,
        trim_whitespace=True,
        # Raised from 512 for the GraphQL option: a Public API token is short, but an
        # `auth_token` is a JWT carrying a whole session's claims and routinely runs past 1KB.
        # Truncating one would surface as "Segment rejected that token", sending the user to
        # re-copy something they had copied correctly.
        max_length=4096,
        help_text="A Segment Public API token, or an app session auth_token.",
    )
    region = serializers.ChoiceField(choices=["us", "eu"], default="us")

    # Which of the two ways in this is. Defaulted to the Public API so a client written before
    # the second option existed keeps working unchanged -- and so the default is the credential
    # that is scoped and revocable, which is the one to fall back to if the field is ever lost
    # in transit.
    credential = serializers.ChoiceField(
        choices=[
            WorkspaceSession.CREDENTIAL_PUBLIC_API,
            WorkspaceSession.CREDENTIAL_GRAPHQL,
        ],
        default=WorkspaceSession.CREDENTIAL_PUBLIC_API,
    )

    # Which workspace to connect, when the credential can see more than one. Only meaningful
    # for the GraphQL option: a Public API token belongs to exactly one workspace and `GET /`
    # says which, so there is nothing to choose. An `auth_token` is a *person*, and a person is
    # often in dozens -- so the choice is the caller's, and a client that omits it is answered
    # with the list rather than connected to whichever sorted first.
    workspace_id = serializers.CharField(
        required=False,
        allow_blank=True,
        trim_whitespace=True,
        max_length=64,
    )

    # The exact slug to resolve, when the choice offered was `segment-operator` rather than a
    # real workspace -- see `_OPERATOR_SLUG` in views.py. That entry cannot itself be connected
    # to, so this is the second round trip that turns "I clicked the operator gateway" into an
    # actual workspace to add to the list.
    workspace_slug = serializers.CharField(
        required=False,
        allow_blank=True,
        trim_whitespace=True,
        max_length=255,
    )

    def validate_token(self, value):
        # Pasted tokens routinely arrive with a "Bearer " prefix, stray quotes, or
        # both, depending on whether they were copied out of a docs page, a shell
        # command, or a JSON config. Peel repeatedly rather than once, so the
        # order the wrappers appear in does not matter: `Bearer "sgp_x"` and
        # `"Bearer sgp_x"` both reduce to the same thing.
        cleaned = value.strip()
        while True:
            before = cleaned
            cleaned = cleaned.strip().strip("\"'").strip()
            if cleaned.lower().startswith("bearer "):
                cleaned = cleaned[7:]
            if cleaned == before:
                break
        if not cleaned:
            raise serializers.ValidationError("Token cannot be blank.")
        return cleaned


class WorkspaceSerializer(serializers.Serializer):
    """
    Public view of a session. Deliberately has no token field of any kind --
    there is no code path that returns the token to the browser.
    """

    id = serializers.CharField(source="workspace_id")
    name = serializers.CharField(source="workspace_name")
    slug = serializers.CharField(source="workspace_slug")
    region = serializers.CharField()
    # Which of the two ways in this session used, and whether that credential can reach the
    # Public API. The UI needs both: it says nothing about *which* is better, but it does have
    # to be able to explain why "Load workspace" is unavailable on a GraphQL session rather
    # than letting the user find out from a failed request.
    credential = serializers.CharField(source="credential_kind")
    canReadWorkspace = serializers.BooleanField(source="can_read_workspace_api")
