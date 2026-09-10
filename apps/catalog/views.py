"""
Catalog, workspace-resource, and topology endpoints.

Three groups:

* `/api/meta/topology` -- the static rule table. Open, since it contains no
  customer data and the SPA needs it before a token is pasted in order to render
  the palette's zone structure.
* `/api/catalog/*` -- the global Segment catalog from Postgres. Never touches the
  Segment API, so it costs the customer no rate budget. Open for the same reason
  as the topology: it is Segment's catalog, not a workspace's.
* `/api/workspace/*` -- the customer's live resources, read-through cached. All
  require a session; all accept `?refresh=1` to bypass the cache.
"""

import logging

from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.auth_workspace.models import WriteKeyRevealAudit
from apps.auth_workspace.permissions import AllowAny
from apps.segmentapi import endpoints as ep
from apps.segmentapi import topology
from apps.segmentapi.client import SegmentClient
from apps.segmentapi.exceptions import SegmentNotFound

from . import resources
from .models import CatalogComponent
from .serializers import CatalogComponentSerializer

logger = logging.getLogger(__name__)


def _wants_refresh(request) -> bool:
    return request.query_params.get("refresh") in ("1", "true", "yes")


class TopologyView(APIView):
    """The zone and connection rules, so the canvas and the server cannot drift."""

    permission_classes = [AllowAny]

    def get(self, request):
        return Response(topology.as_payload())


class CatalogListView(APIView):
    """
    Global catalog for one kind. Served from Postgres; populated by
    `manage.py sync_catalog`.
    """

    # Open for the same reason as the topology: this is Segment's public catalog,
    # not anybody's workspace. CatalogComponent has no workspace_id at all, so
    # there is nothing here a token could scope.
    permission_classes = [AllowAny]

    kind: str = ""

    def get(self, request):
        queryset = CatalogComponent.objects.filter(kind=self.kind)

        search = request.query_params.get("q")
        if search:
            queryset = queryset.filter(name__icontains=search)

        # Repeat the param to intersect: ?category=CRM&category=Email
        categories = request.query_params.getlist("category")
        if categories:
            queryset = queryset.filter(categories__overlap=categories)

        data = CatalogComponentSerializer(queryset, many=True).data
        return Response(
            {
                "kind": self.kind,
                "count": len(data),
                "items": data,
                # Every distinct category for this kind, so the palette can build
                # its filter list without a second request.
                "categories": sorted(
                    {
                        category
                        for values in CatalogComponent.objects.filter(
                            kind=self.kind
                        ).values_list("categories", flat=True)
                        for category in values
                    }
                ),
            }
        )


class CatalogSourcesView(CatalogListView):
    kind = CatalogComponent.SOURCE


class CatalogDestinationsView(CatalogListView):
    kind = CatalogComponent.DESTINATION


class CatalogWarehousesView(CatalogListView):
    kind = CatalogComponent.WAREHOUSE


class WorkspaceResourceView(APIView):
    """
    Base for the simple `/api/workspace/<thing>` reads.

    Subclasses set `loader` to a callable from `resources`. Keeping them uniform
    means the cache bypass and the response envelope are defined once.
    """

    loader = None
    resource_name = ""

    def get(self, request):
        items = self.loader(request.user.session, refresh=_wants_refresh(request))
        return Response({"resource": self.resource_name, "count": len(items), "items": items})


class WorkspaceSourcesView(WorkspaceResourceView):
    resource_name = "sources"
    loader = staticmethod(resources.get_sources)


class WorkspaceDestinationsView(WorkspaceResourceView):
    resource_name = "destinations"
    loader = staticmethod(resources.get_destinations)


class WorkspaceWarehousesView(WorkspaceResourceView):
    resource_name = "warehouses"
    loader = staticmethod(resources.get_warehouses)


class WorkspaceFunctionsView(WorkspaceResourceView):
    resource_name = "functions"
    loader = staticmethod(resources.get_functions)


class WorkspaceReverseEtlModelsView(WorkspaceResourceView):
    resource_name = "reverse_etl_models"
    loader = staticmethod(resources.get_reverse_etl_models)


class WorkspaceSpacesView(WorkspaceResourceView):
    resource_name = "spaces"
    loader = staticmethod(resources.get_spaces)


class WorkspaceAudiencesView(APIView):
    def get(self, request, space_id):
        items = resources.get_audiences(
            request.user.session, space_id, refresh=_wants_refresh(request)
        )
        return Response({"resource": "audiences", "spaceId": space_id, "items": items})


class WorkspaceComputedTraitsView(APIView):
    def get(self, request, space_id):
        traits = resources.get_computed_traits(
            request.user.session, space_id, refresh=_wants_refresh(request)
        )
        return Response(
            {"resource": "computed_traits", "spaceId": space_id, "items": traits}
        )


class WorkspaceDestinationFiltersView(APIView):
    def get(self, request, destination_id):
        items = resources.get_destination_filters(
            request.user.session, destination_id, refresh=_wants_refresh(request)
        )
        return Response(
            {
                "resource": "destination_filters",
                "destinationId": destination_id,
                "items": items,
            }
        )


# --- Space Schema (inspector "available fields" panel) -----------------------
# 25 req/min upstream, so these are fetched lazily per node, never prefetched.

class SpaceEventsView(APIView):
    def get(self, request, space_id):
        items = resources.get_space_events(
            request.user.session, space_id, refresh=_wants_refresh(request)
        )
        return Response({"resource": "space_events", "spaceId": space_id, "items": items})


class SpaceEventPropertiesView(APIView):
    def get(self, request, space_id, event_name):
        items = resources.get_space_event_properties(
            request.user.session, space_id, event_name, refresh=_wants_refresh(request)
        )
        return Response(
            {
                "resource": "space_event_properties",
                "spaceId": space_id,
                "eventName": event_name,
                "items": items,
            }
        )


class SpaceTraitsView(APIView):
    def get(self, request, space_id):
        items = resources.get_space_traits(
            request.user.session, space_id, refresh=_wants_refresh(request)
        )
        return Response({"resource": "space_traits", "spaceId": space_id, "items": items})


class WorkspaceGraphView(APIView):
    """
    The auto-generate call: the whole workspace as a canvas-ready graph.

    Partial results are the norm -- see `resources.build_graph`. Check
    `warnings` in the response rather than assuming completeness.
    """

    def get(self, request):
        graph = resources.build_graph(request.user.session, refresh=_wants_refresh(request))
        return Response(graph)


class RevealWriteKeyView(APIView):
    """
    Return one source's real write key, and log that it happened.

    A write key lets anyone send events into the customer's workspace, so it is
    masked in every other response. This endpoint exists because engineers
    legitimately need the real value during a test, but it is deliberately:

    * POST, not GET -- so it cannot be triggered by a link, a prefetch, or an
      <img> tag, and so it is covered by CSRF.
    * one source at a time -- no bulk reveal.
    * fetched live from Segment, never cached -- the value is not stored here.
    * audited.
    """

    def post(self, request, source_id):
        session = request.user.session
        client = SegmentClient.for_session(session)

        try:
            payload = client.request(ep.GET_SOURCE, path_params={"source_id": source_id})
        except SegmentNotFound:
            return Response(
                {
                    "error": {
                        "code": "source_not_found",
                        "message": f"No source '{source_id}' in this workspace.",
                    }
                },
                status=status.HTTP_404_NOT_FOUND,
            )

        source = (payload.get("data") or {}).get("source") or {}
        write_key = source.get("writeKey")
        if not write_key:
            return Response(
                {
                    "error": {
                        "code": "no_write_key",
                        "message": "Segment returned no write key for that source.",
                    }
                },
                status=status.HTTP_404_NOT_FOUND,
            )

        WriteKeyRevealAudit.objects.create(
            workspace_id=session.workspace_id,
            session_id=session.id,
            source_id=source_id,
            user_agent=request.META.get("HTTP_USER_AGENT", "")[:512],
        )
        # Log the event, never the key.
        logger.info(
            "Write key revealed for source %s in workspace %s",
            source_id,
            session.workspace_id,
        )
        return Response({"sourceId": source_id, "writeKey": write_key})
