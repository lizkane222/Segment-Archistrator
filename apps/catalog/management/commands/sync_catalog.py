"""
Populate CatalogComponent from the global Segment catalog.

Run on deploy and nightly. Once this has run, the palette is served entirely from
Postgres, so browsing hundreds of destination types costs the customer nothing
against their rate limit.

Token resolution, in order:
  1. --token
  2. SEGMENT_CATALOG_TOKEN
  3. the most recently seen WorkspaceSession

(3) is a convenience for local development so a fresh clone can populate the
catalog without extra configuration. On Render, set SEGMENT_CATALOG_TOKEN.
"""

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.segmentapi import schemas
from apps.segmentapi.client import SegmentClient
from apps.segmentapi.exceptions import SegmentError

from ...models import CatalogComponent

KINDS = {
    "source": "catalog_sources",
    "destination": "catalog_destinations",
    "warehouse": "catalog_warehouses",
}


class Command(BaseCommand):
    help = "Sync the global Segment source/destination/warehouse catalog into Postgres."

    def add_arguments(self, parser):
        parser.add_argument("--token", help="Segment Public API token to read the catalog with.")
        parser.add_argument("--region", default=None, choices=["us", "eu"])
        parser.add_argument(
            "--kind",
            action="append",
            choices=sorted(KINDS),
            help="Sync only this kind. Repeatable. Default: all three.",
        )

    def handle(self, *args, **options):
        token, region = self._resolve_token(options)
        client = SegmentClient.for_token(token, region=region)

        for kind in options.get("kind") or sorted(KINDS):
            method = getattr(client, KINDS[kind])
            self.stdout.write(f"Fetching {kind} catalog...")
            try:
                entries = method()
            except SegmentError as exc:
                raise CommandError(f"Failed to fetch the {kind} catalog: {exc.detail}") from exc

            created, updated = self._upsert(kind, entries)
            self.stdout.write(
                self.style.SUCCESS(
                    f"  {kind}: {len(entries)} entries ({created} new, {updated} updated)"
                )
            )

    def _resolve_token(self, options) -> tuple[str, str]:
        if options.get("token"):
            return options["token"], options.get("region") or settings.SEGMENT_CATALOG_REGION

        if settings.SEGMENT_CATALOG_TOKEN:
            return (
                settings.SEGMENT_CATALOG_TOKEN,
                options.get("region") or settings.SEGMENT_CATALOG_REGION,
            )

        from apps.auth_workspace.models import WorkspaceSession

        session = WorkspaceSession.objects.order_by("-last_seen_at").first()
        if session is None:
            raise CommandError(
                "No token available. Pass --token, set SEGMENT_CATALOG_TOKEN, or start "
                "a session in the app first."
            )
        self.stdout.write(
            self.style.WARNING(
                f"Borrowing the token from the '{session.workspace_slug}' session. "
                "Set SEGMENT_CATALOG_TOKEN for unattended runs."
            )
        )
        return session.reveal_token(), options.get("region") or session.region

    @transaction.atomic
    def _upsert(self, kind: str, entries: list[dict]) -> tuple[int, int]:
        """
        Upsert rather than delete-and-recreate.

        An entry vanishing from the catalog is not a reason to break diagrams that
        reference it, so nothing is ever deleted here.
        """
        created = updated = 0
        for raw in entries:
            fields = schemas.normalize_catalog_entry(raw, kind)
            metadata_id = fields.pop("metadata_id")
            fields.pop("kind")
            if not metadata_id:
                continue
            _, was_created = CatalogComponent.objects.update_or_create(
                kind=kind, metadata_id=metadata_id, defaults=fields
            )
            if was_created:
                created += 1
            else:
                updated += 1
        return created, updated
