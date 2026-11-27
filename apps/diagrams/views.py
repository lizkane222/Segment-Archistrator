"""
Diagram CRUD and the seeded template list.

Every read goes through `Diagram.objects.visible_to(request.user)` and every write
through `editable_by`, so an id you cannot see 404s rather than leaking and one you
can see but do not own 403s rather than being overwritten. That is the entire
authorization model, and it is two queryset methods -- which is the point.

The two are not the same set on purpose: being shared a diagram grants reading, not
overwriting. See the docstrings on both in models.py.
"""

from rest_framework import status
from rest_framework.exceptions import PermissionDenied
from rest_framework.generics import get_object_or_404
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.auth_workspace.permissions import AllowAny, HasSession, SignedIn

from .models import Diagram, Template
from .serializers import (
    DiagramListSerializer,
    DiagramSerializer,
    TemplateCreateSerializer,
    TemplateListSerializer,
    TemplateSerializer,
)


def _principal(request):
    """The caller, or None when there is no session (open deployments only)."""
    from apps.auth_workspace.authentication import WorkspacePrincipal

    return request.user if isinstance(request.user, WorkspacePrincipal) else None


class TemplateListView(APIView):
    """
    The built-in reference architectures, plus the ones people have saved.

    Which of those a caller sees is `Template.objects.visible_to`: built-ins to everyone, a
    person's own to them, shared ones to everyone at the company -- except a shared template
    that still carries one workspace's data, which only people holding that workspace see.
    """

    permission_classes = [SignedIn]

    def get(self, request):
        principal = _principal(request)
        templates = Template.objects.visible_to(principal)
        return Response(
            {
                "items": TemplateListSerializer(
                    templates, many=True, context={"principal": principal}
                ).data
            }
        )

    def post(self, request):
        """Save a diagram as a template. Signed-in accounts only: a template needs an author."""
        principal = _principal(request)
        if principal is None or principal.account is None:
            raise PermissionDenied(detail="Sign in to save a template.", code="account_required")
        serializer = TemplateCreateSerializer(data=request.data, context={"principal": principal})
        serializer.is_valid(raise_exception=True)
        template = serializer.save()
        return Response(
            TemplateSerializer(template, context={"principal": principal}).data,
            status=status.HTTP_201_CREATED,
        )


class TemplateDetailView(APIView):
    permission_classes = [SignedIn]

    def get(self, request, key):
        principal = _principal(request)
        template = get_object_or_404(Template.objects.visible_to(principal), pk=key)
        return Response(TemplateSerializer(template, context={"principal": principal}).data)

    def delete(self, request, key):
        """Only the author, and never a built-in: the others can see a template, not remove it."""
        principal = _principal(request)
        template = get_object_or_404(Template.objects.visible_to(principal), pk=key)
        if template.is_builtin or principal is None or template.owner_id != principal.account_id:
            raise PermissionDenied(
                detail="Only the person who saved a template can delete it.",
                code="not_your_template",
            )
        template.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class DiagramListCreateView(APIView):
    # A diagram holds no Segment credentials, so a session with no token -- and no
    # account -- may own one. That is what keeps the canvas usable before anyone
    # signs in or connects anything.
    permission_classes = [HasSession]

    def get(self, request):
        diagrams = Diagram.objects.visible_to(request.user)
        # The context is what lets `owner` say "me" / "shared" / "unclaimed". Without it
        # every row reports "unclaimed" and the open dialog offers Delete on diagrams
        # belonging to other people.
        return Response(
            {
                "items": DiagramListSerializer(
                    diagrams, many=True, context={"principal": request.user}
                ).data
            }
        )

    def post(self, request):
        serializer = DiagramSerializer(
            data=request.data, context={"principal": request.user}
        )
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data, status=status.HTTP_201_CREATED)


class DiagramDetailView(APIView):
    permission_classes = [HasSession]

    def get_object(self, request, diagram_id):
        """Readable. Not necessarily writable -- see `get_editable`."""
        return get_object_or_404(Diagram.objects.visible_to(request.user), pk=diagram_id)

    def get_editable(self, request, diagram_id):
        """
        404 for something you cannot see, 403 for something you can see but do not own.

        Two statuses deliberately, for the same reason this app distinguishes 401 from
        403 elsewhere: the first means "no such diagram" and the second means "this one
        is somebody else's". One status covering both would tell someone looking at a
        diagram on their screen that it does not exist.
        """
        diagram = self.get_object(request, diagram_id)
        if not Diagram.objects.editable_by(request.user).filter(pk=diagram.pk).exists():
            raise PermissionDenied(
                detail="This diagram was shared with you. Save a copy to make changes.",
                code="not_your_diagram",
            )
        return diagram

    def get(self, request, diagram_id):
        return Response(
            DiagramSerializer(
                self.get_object(request, diagram_id), context={"principal": request.user}
            ).data
        )

    def patch(self, request, diagram_id):
        diagram = self.get_editable(request, diagram_id)
        # The context is passed on updates too, not just on create. It used to be
        # omitted here harmlessly, because `create()` was its only reader -- but
        # turning on sharing needs the principal to say which workspace the diagram is
        # about, so an update without it would fail on the one field that matters.
        serializer = DiagramSerializer(
            diagram, data=request.data, partial=True, context={"principal": request.user}
        )
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)

    def put(self, request, diagram_id):
        diagram = self.get_editable(request, diagram_id)
        serializer = DiagramSerializer(
            diagram, data=request.data, context={"principal": request.user}
        )
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data)

    def delete(self, request, diagram_id):
        self.get_editable(request, diagram_id).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
