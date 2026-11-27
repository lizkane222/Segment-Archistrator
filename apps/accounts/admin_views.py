"""
Administration: who the administrators are.

Everything here is gated by `IsAdminAccount`, which is checked per request on the server; the
browser's admin switch only decides whether the controls are drawn.

Two rules keep the app from locking itself out: an owner (ADMIN_EMAILS) cannot be demoted from here,
and nobody can demote themselves -- so there is always at least one administrator who can undo a
mistake.
"""

from django.db.models import Count
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Account
from .permissions import IsAdminAccount


def _user(account: Account) -> dict:
    return {
        "id": str(account.id),
        "email": account.email,
        "name": account.name,
        "avatarUrl": account.avatar_url,
        "createdAt": account.created_at,
        "lastLoginAt": account.last_login_at,
        "isOwner": account.is_owner,
        "isAdmin": account.has_admin_rights,
        "diagrams": getattr(account, "diagram_total", None),
    }


class AdminUserListView(APIView):
    permission_classes = [IsAdminAccount]

    def get(self, request):
        accounts = Account.objects.annotate(diagram_total=Count("diagrams"))
        return Response({"items": [_user(account) for account in accounts]})


class AdminUserDetailView(APIView):
    permission_classes = [IsAdminAccount]

    def patch(self, request, account_id):
        target = Account.objects.filter(pk=account_id).first()
        if target is None:
            return Response(
                {"error": {"code": "not_found", "message": "No such user."}},
                status=status.HTTP_404_NOT_FOUND,
            )
        wanted = request.data.get("isAdmin")
        if not isinstance(wanted, bool):
            return Response(
                {"error": {"code": "invalid", "message": "isAdmin must be true or false."}},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if not wanted:
            if target.is_owner:
                return Response(
                    {"error": {"code": "owner", "message": "Owners are set in ADMIN_EMAILS and cannot be demoted here."}},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            if target.pk == request.user.account_id:
                return Response(
                    {"error": {"code": "self_demotion", "message": "You cannot remove your own administrator access."}},
                    status=status.HTTP_400_BAD_REQUEST,
                )
        target.is_admin = wanted
        target.save(update_fields=["is_admin"])
        return Response(_user(target))
