"""
Nuance list and submit.

Read is open and write needs a session, which is the reverse of the usual asymmetry and
worth saying why: there is nothing workspace-specific to protect on the way out -- a
nuance is a fact about Segment, and the palette and topology are open for the same
reason -- while on the way in the session is the only thing standing between this table
and anyone who finds the endpoint. `HasSession`, not `HasWorkspaceSession`: a Twilion
reading a colleague's diagram before pasting a token still has something worth writing
down.
"""

from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.auth_workspace.permissions import AllowAny, HasSession

from .models import Nuance
from .serializers import NuanceSerializer, NuanceSubmitSerializer

# Enough to read in a popover. Ordering is newest-first, so a kind with a long
# history shows what was learned most recently rather than what was learned first.
PAGE_SIZE = 50


class NuanceListView(APIView):
    permission_classes = [AllowAny]

    def get(self, request):
        kind = request.query_params.get("kind")
        if not kind:
            return Response(
                {
                    "error": {
                        "code": "kind_required",
                        "message": "Ask for the nuances of one component kind.",
                        "fields": {"kind": "This parameter is required."},
                    }
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        nuances = Nuance.objects.visible().for_kind(kind)

        slug = request.query_params.get("slug")
        if slug:
            # Both, not just the slug's own: a nuance about destinations in general
            # is still true of Braze, and filtering it out would mean the most
            # broadly useful notes are the ones nobody ever sees.
            nuances = nuances.filter(slug__in=["", slug])

        return Response({"items": NuanceSerializer(nuances[:PAGE_SIZE], many=True).data})


class NuanceCreateView(APIView):
    permission_classes = [HasSession]

    def post(self, request):
        serializer = NuanceSubmitSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        nuance = serializer.save()
        # Read serializer on the way back, so the client gets the same shape the list
        # gives it and can drop the new row straight into what it is showing.
        return Response(NuanceSerializer(nuance).data, status=status.HTTP_201_CREATED)
