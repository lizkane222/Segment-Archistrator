"""
Diagram CRUD and the seeded template list.

Every diagram query goes through `Diagram.objects.for_workspace(...)`, so an id
from another workspace 404s rather than leaking. That is the entire
authorization model, and it is one line -- which is the point.
"""

from rest_framework import status
from rest_framework.generics import get_object_or_404
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.auth_workspace.permissions import AllowAny, HasSession

from .models import Diagram, Template
from .serializers import (
    DiagramListSerializer,
    DiagramSerializer,
    TemplateListSerializer,
    TemplateSerializer,
)


class TemplateListView(APIView):
    """The seeded reference architectures. Global, not workspace-scoped."""

    # No workspace field on Template, nothing customer-specific in one, and no
    # token needed to read the Segment reference architectures they describe.
    permission_classes = [AllowAny]

    def get(self, request):
        templates = Template.objects.all()
        return Response({"items": TemplateListSerializer(templates, many=True).data})


class TemplateDetailView(APIView):
    permission_classes = [AllowAny]

    def get(self, request, key):
        template = get_object_or_404(Template, pk=key)
        return Response(TemplateSerializer(template).data)


class DiagramListCreateView(APIView):
    # A diagram holds no Segment credentials, so a tokenless session may own one.
    # The authorization boundary is unchanged and still one line: for_workspace()
    # against the session's own workspace_id, synthetic or real.
    permission_classes = [HasSession]

    def get(self, request):
        diagrams = Diagram.objects.for_workspace(request.user.workspace_id)
        return Response({"items": DiagramListSerializer(diagrams, many=True).data})

    def post(self, request):
        serializer = DiagramSerializer(
            data=request.data,
            context={"workspace_id": request.user.workspace_id},
        )
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data, status=status.HTTP_201_CREATED)


class DiagramDetailView(APIView):
    permission_classes = [HasSession]

    def get_object(self, request, diagram_id):
        return get_object_or_404(
            Diagram.objects.for_workspace(request.user.workspace_id), pk=diagram_id
        )

    def get(self, request, diagram_id):
        return Response(DiagramSerializer(self.get_object(request, diagram_id)).data)

    def patch(self, request, diagram_id):
        diagram = self.get_object(request, diagram_id)
        serializer = DiagramSerializer(diagram, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)

    def put(self, request, diagram_id):
        diagram = self.get_object(request, diagram_id)
        serializer = DiagramSerializer(diagram, data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)

    def delete(self, request, diagram_id):
        self.get_object(request, diagram_id).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
