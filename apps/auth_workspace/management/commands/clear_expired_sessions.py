"""
Purge idle workspace sessions.

Expiry is already enforced on every request -- the authentication class rejects
and deletes an expired session when it is presented. This command exists for the
sessions nobody ever comes back for: each surviving row is an encrypted customer
API token sitting at rest for no reason. Run it nightly.
"""

from django.core.management.base import BaseCommand

from apps.auth_workspace.models import WorkspaceSession, WriteKeyRevealAudit


class Command(BaseCommand):
    help = "Delete workspace sessions idle longer than WORKSPACE_SESSION_IDLE_HOURS."

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report what would be deleted without deleting it.",
        )
        parser.add_argument(
            "--audit-retention-days",
            type=int,
            default=None,
            help=(
                "Also delete write-key reveal audit rows older than this many days. "
                "Omitted by default: the audit trail outliving the session is the "
                "point of having one."
            ),
        )

    def handle(self, *args, **options):
        expired = WorkspaceSession.objects.expired()
        count = expired.count()

        if options["dry_run"]:
            self.stdout.write(f"Would delete {count} expired session(s).")
        else:
            expired.delete()
            self.stdout.write(self.style.SUCCESS(f"Deleted {count} expired session(s)."))

        retention = options["audit_retention_days"]
        if retention is not None:
            self._trim_audit(retention, dry_run=options["dry_run"])

    def _trim_audit(self, days, *, dry_run):
        from datetime import timedelta

        from django.utils import timezone

        cutoff = timezone.now() - timedelta(days=days)
        stale = WriteKeyRevealAudit.objects.filter(revealed_at__lt=cutoff)
        count = stale.count()
        if dry_run:
            self.stdout.write(f"Would delete {count} audit row(s) older than {days}d.")
        else:
            stale.delete()
            self.stdout.write(self.style.SUCCESS(f"Deleted {count} audit row(s)."))
