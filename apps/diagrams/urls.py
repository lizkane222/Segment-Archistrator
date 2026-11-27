"""Diagram and template routes. Mounted under /api/."""

from django.urls import path

from . import admin_views, views

urlpatterns = [
    path("templates", views.TemplateListView.as_view(), name="template-list"),
    path("templates/<slug:key>", views.TemplateDetailView.as_view(), name="template-detail"),
    path("admin/templates", admin_views.AdminTemplateListView.as_view(), name="admin-template-list"),
    path("admin/templates/<slug:key>", admin_views.AdminTemplateDetailView.as_view(), name="admin-template-detail"),
    path("diagrams", views.DiagramListCreateView.as_view(), name="diagram-list"),
    path("diagrams/<uuid:diagram_id>", views.DiagramDetailView.as_view(), name="diagram-detail"),
]
