"""
Re-wrap stored tokens under the newest encryption key.

Rotation procedure:

  1. Generate a key:
     python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
  2. *Prepend* it to SEGMENT_TOKEN_ENCRYPTION_KEYS, keeping the old key(s):
     SEGMENT_TOKEN_ENCRYPTION_KEYS=<new>,<old>
  3. Deploy. Everything still decrypts -- MultiFernet tries each key in turn.
  4. Run this command. Every row is re-wrapped under <new>.
  5. Once it reports zero unreadable rows, drop <old> from the env var.

Step 4 before step 5 is the whole point: removing the old key first would
strand every existing row.

This uses MultiFernet.rotate(), so the plaintext token is never materialised in
this process -- ciphertext goes in, ciphertext comes out.
"""

from django.core.management.base import BaseCommand
from django.db import transaction

from apps.auth_workspace.crypto import TokenDecryptionError, rotate_token
from apps.auth_workspace.models import WorkspaceSession

BATCH_SIZE = 200


class Command(BaseCommand):
    help = "Re-encrypt stored Segment tokens under the newest Fernet key."

    def add_arguments(self, parser):
        parser.add_argument(
            "--dry-run",
            action="store_true",
            help="Report readable/unreadable counts without writing.",
        )
        parser.add_argument(
            "--purge-unreadable",
            action="store_true",
            help=(
                "Delete rows that decrypt under no configured key. They are dead "
                "weight -- the session can never be used again -- but deleting is "
                "opt-in in case the key list is simply misconfigured."
            ),
        )

    def handle(self, *args, **options):
        dry_run = options["dry_run"]
        rotated = 0
        unreadable = []

        # Token-bearing rows only. A session with no credential has nothing to
        # re-encrypt, and `rotate_token(None)` raises TypeError from deep inside
        # MultiFernet -- which `TokenDecryptionError` below does not catch, so a single
        # signed-out visitor was enough to abort the whole rotation.
        queryset = (
            WorkspaceSession.objects.exclude(encrypted_token=None)
            .only("id", "encrypted_token")
        )
        for session in queryset.iterator(chunk_size=BATCH_SIZE):
            try:
                new_blob = rotate_token(session.encrypted_token)
            except TokenDecryptionError:
                unreadable.append(session.id)
                continue

            if not dry_run:
                WorkspaceSession.objects.filter(pk=session.pk).update(
                    encrypted_token=new_blob
                )
            rotated += 1

        verb = "Would re-encrypt" if dry_run else "Re-encrypted"
        self.stdout.write(self.style.SUCCESS(f"{verb} {rotated} session token(s)."))

        if not unreadable:
            self.stdout.write("All stored tokens are readable under the current keys.")
            return

        self.stdout.write(
            self.style.WARNING(
                f"{len(unreadable)} session(s) could not be decrypted under any "
                "configured key. Check that the previous key is still present in "
                "SEGMENT_TOKEN_ENCRYPTION_KEYS before purging."
            )
        )
        if options["purge_unreadable"] and not dry_run:
            with transaction.atomic():
                deleted, _ = WorkspaceSession.objects.filter(id__in=unreadable).delete()
            self.stdout.write(self.style.SUCCESS(f"Purged {deleted} unreadable row(s)."))
