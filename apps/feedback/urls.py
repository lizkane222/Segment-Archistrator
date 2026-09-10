from django.urls import path

from .views import FeedbackConfigView, FeedbackView

urlpatterns = [
    path("feedback", FeedbackView.as_view(), name="feedback"),
    path("feedback/config", FeedbackConfigView.as_view(), name="feedback-config"),
]
