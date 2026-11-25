"""
Make an account an administrator (or take it back).

    python manage.py make_admin you@company.com
    python manage.py make_admin someone@company.com --revoke

The account has to exist, i.e. have signed in once. Owners named in ADMIN_EMAILS are administrators
without this and cannot be revoked here.
"""

from django.core.management.base import BaseCommand, CommandError

from apps.accounts.models import Account


class Command(BaseCommand):
    help = "Grant or revoke administrator rights for an account."

    def add_arguments(self, parser):
        parser.add_argument("email")
        parser.add_argument("--revoke", action="store_true")

    def handle(self, *args, email, revoke, **options):
        try:
            account = Account.objects.get(email=email.strip().lower())
        except Account.DoesNotExist as exc:
            raise CommandError(f"No account for {email}. They need to sign in once first.") from exc
        if revoke and account.is_owner:
            raise CommandError(f"{account.email} is an owner (ADMIN_EMAILS); remove it there.")
        account.is_admin = not revoke
        account.save(update_fields=["is_admin"])
        self.stdout.write(self.style.SUCCESS(f"{account.email}: admin={account.is_admin}"))
