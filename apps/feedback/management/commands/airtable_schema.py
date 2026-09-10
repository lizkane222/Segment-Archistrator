"""
Print the structure of the Airtable base the feedback form writes to.

    python manage.py airtable_schema

Two jobs, and the second is the one worth having:

1. **Discovery.** With only a token set it lists every base the token can reach, so `AIRTABLE_BASE_ID`
   does not have to be dug out of a URL. With a base set it lists that base's tables and every field's
   name, type and -- for a single-select -- its allowed options.

2. **Verification.** It checks the fields this app actually writes against what the base actually has,
   and says which are missing or mistyped. That check is the reason this is a management command rather
   than a note in the README: Airtable silently ignores an unknown field name on write when
   `typecast` is on, so a renamed field means feedback that submits successfully, reports success, and
   lands with that column empty. Nothing anywhere would say so.

Read-only. It uses `schema.bases:read` and never `data.records:write`, so running it cannot alter
anything -- which is what makes it safe to run against a base someone else's team maintains.
"""

import json

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from apps.feedback.airtable import (
    FIELD_TYPES,
    WRITTEN_FIELDS,
    AirtableClient,
    AirtableNotConfigured,
)


class Command(BaseCommand):
    help = "List the Airtable bases, tables and fields the feedback form can reach."

    def add_arguments(self, parser):
        parser.add_argument(
            "--json",
            action="store_true",
            help="Emit the raw schema instead of a summary, for piping somewhere else.",
        )

    def handle(self, *args, **options):
        if not settings.AIRTABLE_API_KEY:
            raise CommandError(
                "AIRTABLE_API_KEY is not set. Put a personal access token in .env — it needs "
                "`schema.bases:read` to run this, and `data.records:write` for the form itself.\n"
                "Create one at https://airtable.com/create/tokens"
            )

        try:
            client = AirtableClient.from_settings(require_base=False)
        except AirtableNotConfigured as err:
            raise CommandError(str(err)) from err

        if not settings.AIRTABLE_BASE_ID:
            self._list_bases(client)
            return

        schema = client.base_schema()
        if options["json"]:
            self.stdout.write(json.dumps(schema, indent=2))
            return

        self._describe(schema)

    # --- output --------------------------------------------------------------

    def _list_bases(self, client):
        bases = client.list_bases()
        if not bases:
            raise CommandError(
                "That token can see no bases. Check it has `schema.bases:read` and that the base "
                "is shared with it — an Airtable token grants access per base, not account-wide."
            )
        self.stdout.write(self.style.WARNING("AIRTABLE_BASE_ID is not set. Bases this token can see:\n"))
        for base in bases:
            self.stdout.write(f"  {base.get('id')}  {base.get('name')}")
        self.stdout.write("\nPut the id of the one you want in .env as AIRTABLE_BASE_ID, then re-run.")

    def _describe(self, schema):
        tables = schema.get("tables") or []
        self.stdout.write(self.style.SUCCESS(f"Base {settings.AIRTABLE_BASE_ID}: {len(tables)} table(s)\n"))

        target = None
        for table in tables:
            marker = ""
            if table.get("name") == settings.AIRTABLE_TABLE or table.get("id") == settings.AIRTABLE_TABLE:
                target = table
                marker = self.style.SUCCESS("   <- AIRTABLE_TABLE")
            self.stdout.write(f"  {table.get('name')}{marker}")
            for field in table.get("fields") or []:
                options = field.get("options") or {}
                choices = [choice.get("name") for choice in options.get("choices") or []]
                detail = f" [{', '.join(choices)}]" if choices else ""
                self.stdout.write(f"      {field.get('name')!r}: {field.get('type')}{detail}")
            self.stdout.write("")

        if not target:
            names = ", ".join(table.get("name", "?") for table in tables) or "none"
            raise CommandError(
                f"No table called {settings.AIRTABLE_TABLE!r} in this base. It has: {names}. "
                "Set AIRTABLE_TABLE to one of those."
            )

        self._verify(target)

    def _verify(self, table):
        """
        The fields this app writes, against the fields the base has.

        Named individually rather than as a count, because a missing field is silent on write: with
        `typecast` on, Airtable ignores a field name it does not recognise, so the record is created,
        the API returns success, and that column is simply empty.
        """
        actual = {field["name"]: field for field in table.get("fields") or []}
        self.stdout.write(self.style.SUCCESS("Fields this app writes:"))

        problems = []
        for name in WRITTEN_FIELDS:
            field = actual.get(name)
            if not field:
                problems.append(f"{name!r} is missing from the table")
                self.stdout.write(self.style.ERROR(f"  ✗ {name!r} — not in the table"))
                continue

            wanted = FIELD_TYPES.get(name)
            if wanted and field.get("type") not in wanted:
                problems.append(
                    f"{name!r} is a {field.get('type')}; this app writes it as {' or '.join(wanted)}"
                )
                self.stdout.write(
                    self.style.WARNING(f"  ! {name!r} — is {field.get('type')}, expected {' or '.join(wanted)}")
                )
                continue

            self.stdout.write(f"  ✓ {name!r} — {field.get('type')}")

        self.stdout.write("")
        if problems:
            raise CommandError(
                "The base does not match what this app writes:\n  - "
                + "\n  - ".join(problems)
                + "\n\nEither add or retype those fields in Airtable, or change the names in "
                "apps/feedback/airtable.py to match the base."
            )
        self.stdout.write(self.style.SUCCESS("Every field this app writes exists and is the right type."))
