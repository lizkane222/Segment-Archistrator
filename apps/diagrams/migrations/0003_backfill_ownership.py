"""
Give every existing diagram an owner column that means something, without changing
who can currently see it.

The mapping, and why each half is what it is:

  workspace_id = 'anon:<hex>'  ->  anon_scope = that, workspace_id = ''
      An anonymous scope was never a workspace. Left in `workspace_id` it would make
      the sharing clause in `visible_to` match on a value that names no workspace at
      all.

  workspace_id = 'ws_...'      ->  unchanged, shared_with_workspace = True
      Today's rule is "anyone holding a credential for workspace X sees X's diagrams",
      and that is *precisely* clause 3 of the new rule. So these rows become
      owned-by-nobody-and-shared, which reproduces current behaviour exactly rather
      than through a compatibility branch. Making them private instead would look like
      data loss to anyone who shares a workspace with a colleague.

Owners are assigned afterwards, deliberately and by hand, with
`manage.py claim_diagrams`. Guessing an owner here would be guessing which person a
cookie belonged to.
"""

from django.db import migrations


def forwards(apps, schema_editor):
    Diagram = apps.get_model("diagrams", "Diagram")

    for diagram in Diagram.objects.filter(workspace_id__startswith="anon:").iterator():
        Diagram.objects.filter(pk=diagram.pk).update(
            anon_scope=diagram.workspace_id, workspace_id=""
        )

    # Everything still carrying a real workspace id: same visibility as before, said
    # in the new vocabulary.
    Diagram.objects.exclude(workspace_id="").update(shared_with_workspace=True)


def backwards(apps, schema_editor):
    """
    One-way once anyone has signed in, and it says so rather than guessing.

    An account-owned diagram has no representation in the old model -- `workspace_id`
    cannot name a person -- so the only choices would be to publish it into a workspace
    or to hide it in a scope no cookie names. Both are worse than refusing.
    """
    Diagram = apps.get_model("diagrams", "Diagram")
    if Diagram.objects.filter(owner__isnull=False).exists():
        raise RuntimeError(
            "Cannot reverse: some diagrams are owned by accounts, which the previous "
            "model cannot express. Roll forward, or restore the pre-migration dump."
        )
    for diagram in Diagram.objects.exclude(anon_scope="").iterator():
        Diagram.objects.filter(pk=diagram.pk).update(
            workspace_id=diagram.anon_scope, anon_scope=""
        )


class Migration(migrations.Migration):
    dependencies = [
        ("diagrams", "0002_diagram_anon_scope_diagram_owner_and_more"),
    ]

    operations = [migrations.RunPython(forwards, backwards)]
