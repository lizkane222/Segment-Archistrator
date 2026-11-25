"""
Administration of the built-in Reference architectures: what is offered to everyone.

Two kinds of built-in, and the difference decides what may be changed:

  - *shipped*: seeded from fixtures/templates.json on every deploy. An administrator can withdraw
    or restore it (`published`) and reorder it, but not edit it -- the next deploy would put the
    fixture back, and a change that quietly reverts is worse than one that is refused.
  - *published*: created here (`admin-` keys) from an uploaded or open diagram. These are the
    administrators' own, and can be edited, replaced or deleted.

Whatever is published here is shown to every user, so the graph is held to more than a personal
template is: no workspace's own data in it (that would publish one customer's ids to everyone), and
secrets stripped.
"""

import uuid

from rest_framework import serializers, status
from rest_framework.generics import get_object_or_404
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.accounts.permissions import IsAdminAccount

from .models import Template, carries_workspace_identity, sanitize_graph
from .serializers import DiagramSerializer

PUBLISHED_PREFIX = "admin-"
DEFAULT_CATEGORY = "Reference architecture"


def _row(template: Template) -> dict:
    return {
        "key": template.key,
        "name": template.name,
        "description": template.description,
        "category": template.category,
        "published": template.published,
        "shipped": not template.key.startswith(PUBLISHED_PREFIX),
        "sortOrder": template.sort_order,
        "placeholderCount": template.placeholder_count,
    }


def _clean_graph(value):
    graph = DiagramSerializer().validate_graph(value)
    if carries_workspace_identity(graph):
        raise serializers.ValidationError(
            "This diagram still carries a workspace's own data (bound components or links). "
            "Everyone would see it, so unbind or remove those first."
        )
    return sanitize_graph(graph)


class PublishSerializer(serializers.Serializer):
    name = serializers.CharField(max_length=255, trim_whitespace=True)
    description = serializers.CharField(required=False, allow_blank=True, max_length=10_000)
    category = serializers.CharField(required=False, allow_blank=True, max_length=64)
    graph = serializers.JSONField()
    sort_order = serializers.IntegerField(required=False, min_value=0, max_value=100_000)

    def validate_graph(self, value):
        return _clean_graph(value)


class AdminTemplateListView(APIView):
    permission_classes = [IsAdminAccount]

    def get(self, request):
        rows = Template.objects.filter(is_builtin=True)
        return Response({"items": [_row(template) for template in rows]})

    def post(self, request):
        """Publish a diagram to everyone's Reference architectures."""
        serializer = PublishSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        template = Template.objects.create(
            key=f"{PUBLISHED_PREFIX}{uuid.uuid4().hex[:24]}",
            name=data["name"],
            description=data.get("description", ""),
            category=data.get("category") or DEFAULT_CATEGORY,
            graph=data["graph"],
            is_builtin=True,
            published=True,
            sort_order=data.get("sort_order", 100),
        )
        return Response(_row(template), status=status.HTTP_201_CREATED)


class AdminTemplateDetailView(APIView):
    permission_classes = [IsAdminAccount]

    def patch(self, request, key):
        template = get_object_or_404(Template.objects.filter(is_builtin=True), pk=key)
        shipped = not template.key.startswith(PUBLISHED_PREFIX)
        body = request.data

        editable = {"name", "description", "category", "graph"}
        if shipped and editable & set(body):
            raise serializers.ValidationError(
                {"detail": "A shipped template is re-seeded on every deploy, so only whether it is published and its order can change."}
            )

        if "published" in body:
            if not isinstance(body["published"], bool):
                raise serializers.ValidationError({"published": "Must be true or false."})
            template.published = body["published"]
        if "sortOrder" in body:
            order = body["sortOrder"]
            if isinstance(order, bool) or not isinstance(order, int) or not 0 <= order <= 100_000:
                raise serializers.ValidationError({"sortOrder": "Must be a whole number from 0 to 100000."})
            template.sort_order = order
        if "name" in body:
            template.name = PublishSerializer().fields["name"].run_validation(body["name"])
        if "description" in body:
            template.description = PublishSerializer().fields["description"].run_validation(body["description"])
        if "category" in body:
            template.category = (
                PublishSerializer().fields["category"].run_validation(body["category"]) or DEFAULT_CATEGORY
            )
        if "graph" in body:
            template.graph = _clean_graph(body["graph"])
        template.save()
        return Response(_row(template))

    def delete(self, request, key):
        template = get_object_or_404(Template.objects.filter(is_builtin=True), pk=key)
        if not template.key.startswith(PUBLISHED_PREFIX):
            raise serializers.ValidationError(
                {"detail": "A shipped template would come back on the next deploy. Unpublish it instead."}
            )
        template.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
