"""
Admit somebody by hand.

The cold-start path: with `ALLOWED_EMAIL_DOMAINS` empty, nothing in the running app
can admit the first person, because inviting requires an account and there are none.
This command has no such problem, and it is the intended way to let yourself in on a
fresh deployment.

    manage.py invite_user --email you@example.com
    manage.py invite_user --list
"""

from django.core.management.base import BaseCommand, CommandError

from apps.accounts.admission import domain_allowed, invite, normalize_email
from apps.accounts.models import Account, Invitation


class Command(BaseCommand):
    help = "Invite an email address to sign in, or list outstanding invitations."

    def add_arguments(self, parser):
        parser.add_argument("--email", help="The address to admit.")
        parser.add_argument(
            "--list",
            action="store_true",
            dest="show_list",
            help="Show invitations and accounts instead of creating anything.",
        )

    def handle(self, *args, **options):
        if options["show_list"]:
            return self._show()

        email = normalize_email(options.get("email") or "")
        if not email:
            raise CommandError("Give --email, or --list to see what already exists.")
        if "@" not in email:
            raise CommandError(f"{email!r} does not look like an email address.")

        if Account.objects.filter(email=email).exists():
            self.stdout.write(f"{email} already has an account. Nothing to do.")
            return

        if domain_allowed(email):
            # Not an error: the invitation is simply redundant, and saying so is more
            # useful than creating a row that will never be looked at.
            self.stdout.write(
                f"{email} is already admitted by ALLOWED_EMAIL_DOMAINS. "
                "No invitation needed -- they can sign in now."
            )
            return

        existing = Invitation.objects.filter(email=email, accepted_at__isnull=True).first()
        invitation = invite(email=email, invited_by=None)
        if existing is not None:
            self.stdout.write(f"{email} was already invited on {invitation.created_at:%Y-%m-%d}.")
        else:
            self.stdout.write(self.style.SUCCESS(f"Invited {email}."))

        # Said plainly, because there is no mail and a command that looks like it sent
        # one would leave someone waiting for an email that is never coming.
        self.stdout.write(
            "No email was sent. Send them the app's URL and ask them to sign in with "
            "Google using this address."
        )

    def _show(self):
        accounts = Account.objects.all()
        self.stdout.write(f"Accounts ({accounts.count()}):")
        for account in accounts:
            seen = f"{account.last_login_at:%Y-%m-%d}" if account.last_login_at else "never"
            self.stdout.write(f"  {account.email}  last signed in: {seen}")

        pending = Invitation.objects.filter(accepted_at__isnull=True)
        self.stdout.write(f"\nPending invitations ({pending.count()}):")
        for invitation in pending:
            by = invitation.invited_by.email if invitation.invited_by else "the CLI"
            self.stdout.write(
                f"  {invitation.email}  invited by {by} on {invitation.created_at:%Y-%m-%d}"
            )

        from django.conf import settings

        domains = ", ".join(settings.ALLOWED_EMAIL_DOMAINS) or "(none -- invitation only)"
        self.stdout.write(f"\nAuto-admitted domains: {domains}")
