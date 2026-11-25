"""Who may administer the app. Checked on every admin endpoint; the browser's admin switch is cosmetic."""

from rest_framework import permissions

from apps.auth_workspace.authentication import WorkspacePrincipal


class IsAdminAccount(permissions.BasePermission):
    message = "Administrator access is required."
    code = "admin_required"

    def has_permission(self, request, view):
        user = request.user
        if not isinstance(user, WorkspacePrincipal):
            return False
        account = user.account
        return bool(account and account.has_admin_rights)
