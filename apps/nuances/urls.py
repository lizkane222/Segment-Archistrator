"""Nuance routes. Mounted under /api/."""

from django.urls import path

from . import views

urlpatterns = [
    path("nuances", views.NuanceListView.as_view(), name="nuance-list"),
    path("nuances/submit", views.NuanceCreateView.as_view(), name="nuance-submit"),
]
