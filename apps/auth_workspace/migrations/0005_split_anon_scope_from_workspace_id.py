"""
Move `anon:<hex>` values out of `workspace_id` and into `anon_scope`.

`workspace_id` used to hold both real Segment workspace ids and synthetic anonymous
scopes, which is what let "which workspace is this about" and "who may see this" be
one column. Separating them is the point of this change; this migration is the half
that moves existing rows over.

Every session also ends up with a non-empty `anon_scope`, including sessions that
were connected to a real workspace. That is load-bearing rather than tidiness: a
diagram saved by a session with no scope and no account would land with no owner at
all, and `visible_to` would not return it to the person who just created it.
"""

import uuid

from django.db import migrations


def forwards(apps, schema_editor):
    WorkspaceSession = apps.get_model("auth_workspace", "WorkspaceSession")

    # An anonymous scope was never a workspace. Move it across and blank the subject.
    for session in WorkspaceSession.objects.filter(workspace_id__startswith="anon:").iterator():
        WorkspaceSession.objects.filter(pk=session.pk).update(
            anon_scope=session.workspace_id, workspace_id=""
        )

    # Connected sessions keep their workspace_id and gain a scope of their own, so
    # anything they save from here on has an owner.
    for session in WorkspaceSession.objects.filter(anon_scope="").iterator():
        WorkspaceSession.objects.filter(pk=session.pk).update(
            anon_scope=f"anon:{uuid.uuid4().hex[:12]}"
        )


def backwards(apps, schema_editor):
    """
    Put the scopes back where they came from.

    Reversible only in the sense that matters: a session that had a scope in
    `workspace_id` gets it back. A scope generated above for a connected session is
    dropped rather than written over that session's real workspace id, which would
    be data loss disguised as a rollback.
    """
    WorkspaceSession = apps.get_model("auth_workspace", "WorkspaceSession")
    for session in WorkspaceSession.objects.exclude(anon_scope="").filter(workspace_id="").iterator():
        WorkspaceSession.objects.filter(pk=session.pk).update(
            workspace_id=session.anon_scope, anon_scope=""
        )


class Migration(migrations.Migration):
    dependencies = [
        ("auth_workspace", "0004_remove_workspacesession_uniq_workspace_token_and_more"),
    ]

    operations = [migrations.RunPython(forwards, backwards)]
