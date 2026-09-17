"""
Diagrams and templates.

`graph` holds the whole React Flow document as JSONB: {nodes, edges, viewport}.
Relational node/edge tables were considered and rejected -- the graph is always
read and written as a unit, nothing ever queries an individual node, so tables
would add joins for no benefit.
"""

import operator
import re
import uuid
from functools import reduce

from django.db import models

# Anything matching these keys is stripped before a graph is persisted. A client
# bug should not be able to bake a live credential into stored JSON.
SECRET_KEY_PATTERN = re.compile(
    r"(write[_-]?key|writeKey|api[_-]?key|token|secret|password|credential)",
    re.IGNORECASE,
)
# The masked field the frontend is allowed to keep.
ALLOWED_MASKED_KEYS = {"writeKeyMasked", "writeKeyLast4"}


def sanitize_graph(graph):
    """
    Recursively drop secret-shaped keys from a graph document.

    Keeps the explicitly masked fields, since those are the intended display
    values and contain no usable secret.
    """
    if isinstance(graph, dict):
        cleaned = {}
        for key, value in graph.items():
            if key in ALLOWED_MASKED_KEYS:
                cleaned[key] = value
                continue
            if SECRET_KEY_PATTERN.search(key):
                continue
            cleaned[key] = sanitize_graph(value)
        return cleaned
    if isinstance(graph, list):
        return [sanitize_graph(item) for item in graph]
    return graph


def is_placeholder(node: dict) -> bool:
    """
    Is this node still waiting to be bound to a real Segment component?

    Reads through `data` as well as the top level: a template's nodes are flat,
    while a graph round-tripped through React Flow may keep its fields under
    `data`. Accepting both means neither writer has to care.
    """
    fields = {**node, **(node.get("data") or {})}
    if fields.get("bound", False):
        return False
    # bindable defaults True: an unbound node with no opinion is a placeholder.
    return fields.get("bindable", True) is not False


class Template(models.Model):
    """
    A reference architecture. v1 ships builtin templates only, seeded from
    fixtures; user-authored templates are v2.

    Nodes in a template graph carry `bound: false` plus a `binds` hint describing
    what real component may be bound to them.
    """

    key = models.SlugField(max_length=64, primary_key=True)
    name = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    category = models.CharField(max_length=64, blank=True)
    graph = models.JSONField(default=dict)
    is_builtin = models.BooleanField(default=True)
    sort_order = models.IntegerField(default=0)

    class Meta:
        ordering = ["sort_order", "name"]

    def __str__(self):
        return self.name

    @property
    def placeholder_count(self) -> int:
        """
        How many nodes are waiting to be bound to a real component.

        Excludes nodes that cannot be bound at all -- a journey has no Public API
        resource behind it, so counting it would leave a banner reading "1
        placeholder to bind" that no amount of binding could ever clear.
        """
        return sum(1 for node in self.graph.get("nodes", []) if is_placeholder(node))


class DiagramQuerySet(models.QuerySet):
    def visible_to(self, principal):
        """
        The authorization boundary. Every read must go through this.

        Three ways a diagram is yours to see, OR-ed together:

          1. You are signed in and you own it.
          2. You are holding the cookie whose anonymous scope owns it.
          3. It is shared with a workspace you hold a credential for.

        (1) and (2) are both offered to a signed-in caller rather than one or the
        other. Anything drawn in this browser before signing in still belongs to this
        cookie until the claim runs, and a session whose claim half-failed must not
        lose sight of its own work.

        (3) reads the workspace set off the credentials the caller actually holds --
        never off anything the client sends -- and uses *all* of them rather than
        whichever is active, because "which tab am I looking at" is not an access
        decision.
        """
        if principal is None:
            return self.none()

        clauses = []
        if getattr(principal, "account_id", None):
            clauses.append(models.Q(owner_id=principal.account_id))
        if getattr(principal, "anon_scope", ""):
            clauses.append(models.Q(anon_scope=principal.anon_scope))
        workspace_ids = getattr(principal, "connected_workspace_ids", None) or []
        if workspace_ids:
            clauses.append(
                models.Q(shared_with_workspace=True, workspace_id__in=workspace_ids)
            )

        if not clauses:
            return self.none()
        # No .distinct(): every clause filters this table alone, so no join can
        # duplicate a row.
        return self.filter(reduce(operator.or_, clauses))

    def editable_by(self, principal):
        """
        Narrower than `visible_to`: being shared something grants reading, not
        overwriting.

        The first two clauses are ownership. The third is the rows that predate
        accounts -- owned by nobody, about a workspace, and writable by whoever holds
        a credential for it, which is exactly what they were before this model
        existed. Without it, every diagram in the database becomes read-only the
        moment this ships. `manage.py claim_diagrams` is how they acquire an owner;
        once every row has one, that clause matches nothing and can be deleted.
        """
        if principal is None:
            return self.none()

        clauses = []
        if getattr(principal, "account_id", None):
            clauses.append(models.Q(owner_id=principal.account_id))
        if getattr(principal, "anon_scope", ""):
            clauses.append(models.Q(anon_scope=principal.anon_scope))
        workspace_ids = getattr(principal, "connected_workspace_ids", None) or []
        if workspace_ids:
            clauses.append(
                models.Q(
                    owner__isnull=True,
                    anon_scope="",
                    workspace_id__in=workspace_ids,
                )
            )

        if not clauses:
            return self.none()
        return self.filter(reduce(operator.or_, clauses))

    def claim_for_account(self, *, anon_scope: str, account) -> int:
        """
        Move an anonymous scope's diagrams to an account. Returns how many moved.

        Exists for one caller: someone who drew something before signing in. Holding
        the cookie for `anon_scope` is the only proof of ownership over it, so the
        caller must already have it -- there is no other way to establish that claim,
        which is why this is not a general "give me those diagrams" primitive.

        Clears `anon_scope` as it goes, so the diagram has exactly one owner
        afterwards and a stale cookie cannot still reach it.

        update(), not a save() loop: sanitize_graph has already run on every one of
        these rows on the way in, and re-running it would rewrite JSONB for no reason
        on a request the user is waiting on.
        """
        if not anon_scope or account is None:
            return 0
        return self.filter(anon_scope=anon_scope).update(owner=account, anon_scope="")

    def reassign_workspace(self, *, from_id: str, to_id: str) -> int:
        """
        Retag diagrams from one workspace to another. Returns how many moved.

        Now only about the *subject* of a diagram, not about who may see it -- that
        moved to `visible_to`. Kept because connecting a credential still needs to say
        "the things you drew are about this workspace", and because the management
        command that repairs orphaned rows uses it.
        """
        if not from_id or not to_id or from_id == to_id:
            return 0
        return self.filter(workspace_id=from_id).update(workspace_id=to_id)


class Diagram(models.Model):
    """
    One saved architecture.

    Ownership and subject are two different columns, and separating them is the point
    of this model's second version. `owner`/`anon_scope` answer "whose is this";
    `workspace_id` answers "what is it about". They used to be the same string, which
    is how losing a cookie lost the work behind it and why an anonymous scope had to
    masquerade as a workspace id.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    # --- whose it is --------------------------------------------------------
    #
    # Ordinarily exactly one of these is set. Both blank is legal and means a row that
    # predates accounts: `editable_by` keeps those reachable by anyone holding a
    # credential for `workspace_id`, exactly as they were, until `claim_diagrams`
    # gives them an owner. That is why there is no CheckConstraint here, unlike
    # elsewhere -- a third state has to remain storable.
    owner = models.ForeignKey(
        "accounts.Account",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="diagrams",
    )
    # The anonymous scope of the session that drew it, when nobody was signed in.
    # Cleared by `claim_for_account`, so a claimed diagram has one owner and a stale
    # cookie cannot still reach it.
    anon_scope = models.CharField(max_length=64, blank=True, db_index=True)

    # --- what it is about --------------------------------------------------
    #
    # Scoping key, not a foreign key: sessions come and go, diagrams outlive them.
    # Blank is meaningful -- something drawn before any workspace was connected is
    # about no workspace in particular, and claiming otherwise would let the sharing
    # clause act on a lie.
    workspace_id = models.CharField(max_length=64, db_index=True, blank=True)

    # Off by default: mine unless I say otherwise. When true, anyone holding a
    # credential for `workspace_id` may *read* this -- see `visible_to` versus
    # `editable_by`.
    shared_with_workspace = models.BooleanField(default=False)

    name = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    graph = models.JSONField(default=dict)
    source_template = models.CharField(max_length=64, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    objects = DiagramQuerySet.as_manager()

    class Meta:
        indexes = [
            models.Index(fields=["workspace_id", "-updated_at"]),
            models.Index(fields=["owner", "-updated_at"]),
            models.Index(fields=["anon_scope", "-updated_at"]),
            models.Index(fields=["workspace_id", "shared_with_workspace"]),
        ]
        ordering = ["-updated_at"]

    def __str__(self):
        return f"{self.name} ({self.owner or self.anon_scope or 'unclaimed'})"

    def save(self, *args, **kwargs):
        self.graph = sanitize_graph(self.graph or {})
        super().save(*args, **kwargs)

    @property
    def node_count(self) -> int:
        return len(self.graph.get("nodes", []))

    @property
    def placeholder_count(self) -> int:
        """Unbound nodes remaining, so the diagram list can say "3 left to bind"."""
        return sum(1 for node in self.graph.get("nodes", []) if is_placeholder(node))
