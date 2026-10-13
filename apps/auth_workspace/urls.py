from django.urls import path

from .views import AnonymousSessionView, HealthView, ResumeConnectionView, SessionView

urlpatterns = [
    path("session", SessionView.as_view(), name="session"),
    path("session/resume", ResumeConnectionView.as_view(), name="session-resume"),
    path("session/anonymous", AnonymousSessionView.as_view(), name="session-anonymous"),
    path("health", HealthView.as_view(), name="health"),
]
