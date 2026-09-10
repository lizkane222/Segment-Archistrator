from django.urls import path

from .views import AnonymousSessionView, HealthView, SessionView

urlpatterns = [
    path("session", SessionView.as_view(), name="session"),
    path("session/anonymous", AnonymousSessionView.as_view(), name="session-anonymous"),
    path("health", HealthView.as_view(), name="health"),
]
