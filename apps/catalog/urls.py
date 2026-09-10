"""Catalog, workspace-resource, and topology routes. Mounted under /api/."""

from django.urls import path

from . import views

urlpatterns = [
    path("meta/topology", views.TopologyView.as_view(), name="topology"),
    # Global catalog, from Postgres.
    path("catalog/sources", views.CatalogSourcesView.as_view(), name="catalog-sources"),
    path(
        "catalog/destinations",
        views.CatalogDestinationsView.as_view(),
        name="catalog-destinations",
    ),
    path(
        "catalog/warehouses",
        views.CatalogWarehousesView.as_view(),
        name="catalog-warehouses",
    ),
    # The customer's live workspace.
    path("workspace/graph", views.WorkspaceGraphView.as_view(), name="workspace-graph"),
    path("workspace/sources", views.WorkspaceSourcesView.as_view(), name="workspace-sources"),
    # POST-only and audited -- a write key must not be reachable by a link.
    path(
        "workspace/sources/<str:source_id>/reveal-write-key",
        views.RevealWriteKeyView.as_view(),
        name="reveal-write-key",
    ),
    path(
        "workspace/destinations",
        views.WorkspaceDestinationsView.as_view(),
        name="workspace-destinations",
    ),
    path(
        "workspace/destinations/<str:destination_id>/filters",
        views.WorkspaceDestinationFiltersView.as_view(),
        name="workspace-destination-filters",
    ),
    path(
        "workspace/warehouses",
        views.WorkspaceWarehousesView.as_view(),
        name="workspace-warehouses",
    ),
    path("workspace/functions", views.WorkspaceFunctionsView.as_view(), name="workspace-functions"),
    path(
        "workspace/reverse-etl-models",
        views.WorkspaceReverseEtlModelsView.as_view(),
        name="workspace-retl-models",
    ),
    path("workspace/spaces", views.WorkspaceSpacesView.as_view(), name="workspace-spaces"),
    path(
        "workspace/spaces/<str:space_id>/audiences",
        views.WorkspaceAudiencesView.as_view(),
        name="workspace-audiences",
    ),
    path(
        "workspace/spaces/<str:space_id>/computed-traits",
        views.WorkspaceComputedTraitsView.as_view(),
        name="workspace-computed-traits",
    ),
    # Space Schema. Lazy-loaded by the inspector; 25 req/min upstream.
    path(
        "workspace/spaces/<str:space_id>/events",
        views.SpaceEventsView.as_view(),
        name="space-events",
    ),
    path(
        "workspace/spaces/<str:space_id>/events/<str:event_name>/properties",
        views.SpaceEventPropertiesView.as_view(),
        name="space-event-properties",
    ),
    path(
        "workspace/spaces/<str:space_id>/traits",
        views.SpaceTraitsView.as_view(),
        name="space-traits",
    ),
]
