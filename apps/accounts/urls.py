"""Account routes. Mounted under /api/."""

from django.urls import path

from . import admin_views, views

urlpatterns = [
    path("auth/google/start", views.GoogleStartView.as_view(), name="google-start"),
    path("auth/google/callback", views.GoogleCallbackView.as_view(), name="google-callback"),
    path("auth/logout", views.LogoutView.as_view(), name="logout"),
    path("invitations", views.InvitationView.as_view(), name="invitations"),
    path("admin/users", admin_views.AdminUserListView.as_view(), name="admin-users"),
    path("admin/users/<uuid:account_id>", admin_views.AdminUserDetailView.as_view(), name="admin-user"),
]
