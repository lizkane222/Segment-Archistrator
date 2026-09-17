"""
Give an owner to diagrams that have none.

Two kinds of row arrive here. Diagrams drawn before accounts existed, which the
ownership migration left owned-by-nobody; and diagrams drawn anonymously whose cookie
is gone, which is the failure that prompted this whole change -- the scope is still on
the row, but nothing can present it any more.

Deliberately a command and not something the app does on first sign-in. Guessing that
whoever signs in first owns an orphaned scope is right on a laptop and wrong on a
shared deployment, and being wrong means handing someone else's work to a stranger.

    manage.py claim_diagrams --list
    manage.py claim_diagrams --email you@example.com --scope anon:f83d787642f9
    manage.py claim_diagrams --email you@example.com --workspace 5urSrBJ68rXLV4vdkvdTjv
"""

from django.core.management.base import BaseCommand, CommandError
from django.db.models import Count

from apps.accounts.models import Account
from apps.diagrams.models import Diagram


class Command(BaseCommand):
    help = "Assign ownerless diagrams to an account."

    def add_arguments(self, parser):
        parser.add_argument("--email", help="The account to assign them to.")
        parser.add_argument("--scope", help="An anonymous scope, e.g. anon:f83d787642f9.")
        parser.add_argument("--workspace", help="A Segment workspace id.")
        parser.add_argument(
            "--list",
            action="store_true",
            dest="show_list",
            help="Show what is unowned instead of changing anything.",
        )
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report what would move, and write nothing.",
        )

    def handle(self, *args, **options):
        if options["show_list"]:
            return self._show()

        email = (options.get("email") or "").strip().lower()
        scope = (options.get("scope") or "").strip()
        workspace = (options.get("workspace") or "").strip()

        if not email:
            raise CommandError("Give --email, or --list to see what is unowned.")
        if not scope and not workspace:
            raise CommandError("Give --scope or --workspace to say which diagrams to claim.")
        if scope and workspace:
            raise CommandError("Give one of --scope or --workspace, not both.")

        try:
            account = Account.objects.get(email=email)
        except Account.DoesNotExist:
            # An account only exists once someone has signed in, so this is a real
            # possibility rather than a typo, and the fix differs.
            raise CommandError(
                f"No account for {email}. They must sign in once first "
                f"(and be invited, if their domain is not allowed)."
            ) from None

        if scope:
            targets = Diagram.objects.filter(anon_scope=scope)
            described = f"anonymous scope {scope}"
        else:
            # Only the ones nobody owns. Without this, re-running the command with a
            # workspace id would take diagrams away from their actual owners.
            targets = Diagram.objects.filter(
                workspace_id=workspace, owner__isnull=True, anon_scope=""
            )
            described = f"workspace {workspace}"

        count = targets.count()
        if not count:
            self.stdout.write(f"Nothing unowned in {described}.")
            return

        for diagram in targets:
            self.stdout.write(f"  {diagram.name}")

        if options["dry_run"]:
            self.stdout.write(f"Would assign {count} diagram(s) in {described} to {email}.")
            return

        # Clear the scope as we go: one owner per diagram, so a cookie that resurfaces
        # later cannot still reach something an account now owns.
        moved = targets.update(owner=account, anon_scope="")
        self.stdout.write(
            self.style.SUCCESS(f"Assigned {moved} diagram(s) in {described} to {email}.")
        )

    def _show(self):
        scopes = (
            Diagram.objects.filter(owner__isnull=True)
            .exclude(anon_scope="")
            .values("anon_scope")
            .annotate(n=Count("id"))
            .order_by("-n")
        )
        self.stdout.write("Diagrams in an anonymous scope with no account:")
        if not scopes:
            self.stdout.write("  (none)")
        for row in scopes:
            self.stdout.write(f"  {row['anon_scope']}  {row['n']} diagram(s)")
            for diagram in Diagram.objects.filter(anon_scope=row["anon_scope"]):
                self.stdout.write(f"      {diagram.name}")

        unclaimed = (
            Diagram.objects.filter(owner__isnull=True, anon_scope="")
            .exclude(workspace_id="")
            .values("workspace_id")
            .annotate(n=Count("id"))
            .order_by("-n")
        )
        self.stdout.write("\nDiagrams with no owner at all (predate accounts):")
        if not unclaimed:
            self.stdout.write("  (none)")
        for row in unclaimed:
            self.stdout.write(f"  workspace {row['workspace_id']}  {row['n']} diagram(s)")

        stranded = Diagram.objects.filter(
            owner__isnull=True, anon_scope="", workspace_id=""
        ).count()
        if stranded:
            # No scope, no workspace, no owner: nothing can select these but a direct
            # id, so they need naming explicitly or they look like they vanished.
            self.stdout.write(
                self.style.WARNING(
                    f"\n{stranded} diagram(s) have no owner, scope or workspace and are "
                    f"unreachable through the API. Claim them with --scope '' is not "
                    f"possible; assign them in a shell or export them."
                )
            )
