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
#
# Substring matches, so they are written to be specific: `auth` alone would also eat
# `author`, which is why the short, ambiguous names live in the exact-match set below.
SECRET_KEY_PATTERN = re.compile(
    r"(write[_-]?key|writeKey|api[_-]?key|token|secret|passw(or)?d|passphrase|credential"
    r"|private[_-]?key|access[_-]?key|authorization|bearer|cookie|connection[_-]?string)",
    re.IGNORECASE,
)
# Whole-key matches: names that are credentials only when they are the entire key.
SECRET_EXACT_KEYS = frozenset({"auth", "pwd", "pass", "dsn", "jwt", "sig"})
# The masked field the frontend is allowed to keep.
ALLOWED_MASKED_KEYS = {"writeKeyMasked", "writeKeyLast4"}

# Keys whose value is rendered as a link or an image. Only an http(s) URL may be stored
# under them: a `javascript:` value in a diagram shared with a workspace is script that
# runs in the origin of whoever clicks it.
URL_KEY_PATTERN = re.compile(r"(^|[a-z])(url|href)$", re.IGNORECASE)
SAFE_URL_PATTERN = re.compile(r"^https?://", re.IGNORECASE)
# `scheme://user:password@host` -- a connection string pasted into a field with an innocent
# name. The userinfo is dropped; the host and path are what a diagram wants to show.
URL_USERINFO_PATTERN = re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://)[^/\s:@]*:[^/\s@]*@")

# Deeper than any diagram a person draws. Bounds the recursion below, so a hostile body of
# nested arrays is a 400 rather than a RecursionError and a 500.
MAX_GRAPH_DEPTH = 64


def is_secret_key(key) -> bool:
    key = str(key)
    return key.lower() in SECRET_EXACT_KEYS or bool(SECRET_KEY_PATTERN.search(key))


def graph_depth(value) -> int:
    """Nesting depth of a JSON value, walked iteratively so it cannot itself overflow."""
    deepest = 0
    stack = [(value, 1)]
    while stack:
        item, depth = stack.pop()
        if isinstance(item, dict):
            children = item.values()
        elif isinstance(item, list):
            children = item
        else:
            continue
        deepest = max(deepest, depth)
        if deepest > MAX_GRAPH_DEPTH:
            return deepest
        stack.extend((child, depth + 1) for child in children)
    return deepest


def sanitize_graph(graph):
    """
    Recursively drop secret-shaped keys from a graph document.

    Keeps the explicitly masked fields, since those are the intended display
    values and contain no usable secret. Also drops a link/image URL that is not
    http(s), and strips credentials embedded in a URL's userinfo.
    """
    if isinstance(graph, dict):
        cleaned = {}
        for key, value in graph.items():
            if key in ALLOWED_MASKED_KEYS:
                cleaned[key] = value
                continue
            if is_secret_key(key):
                continue
            if (
                isinstance(key, str)
                and URL_KEY_PATTERN.search(key)
                and isinstance(value, str)
                and value.strip()
                and not SAFE_URL_PATTERN.match(value.strip())
            ):
                continue
            cleaned[key] = sanitize_graph(value)
        return cleaned
    if isinstance(graph, list):
        return [sanitize_graph(item) for item in graph]
    if isinstance(graph, str) and "://" in graph:
        return URL_USERINFO_PATTERN.sub(r"\1", graph)
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


def has_bound_nodes(graph: dict) -> bool:
    """
    Does this graph hold any component bound to a real workspace resource?

    A bound node is the evidence that a diagram is *about* a particular workspace,
    which is what stamping `workspace_id` on save keys off. Same flat-or-nested read
    as `is_placeholder`.
    """
    for node in (graph or {}).get("nodes") or []:
        if not isinstance(node, dict):
            continue
        fields = {**node, **(node.get("data") or {})}
        if fields.get("bound") and fields.get("segmentId"):
            return True
    return False


# What marks a component as being *this workspace's own*: its resource id, its link into the
# workspace, and the masked write key. A template still carrying any of them describes one
# workspace and may only be used by people who hold it -- see `Template.locked_workspace_id`.
# Mirrors IDENTITY_KEYS in frontend/src/diagram/templatize.js.
WORKSPACE_IDENTITY_KEYS = (
    "segmentId",
    "sourceId",
    "destinationId",
    "spaceId",
    "workspaceUrl",
    "previewWebhookUrl",
    "writeKeyMasked",
    "writeKeyLast4",
)


def carries_workspace_identity(graph) -> bool:
    for node in (graph or {}).get("nodes") or []:
        if not isinstance(node, dict):
            continue
        fields = {**node, **(node.get("data") or {})}
        if any(fields.get(key) for key in WORKSPACE_IDENTITY_KEYS):
            return True
    return False


class TemplateQuerySet(models.QuerySet):
    def visible_to(self, principal):
        """
        The authorization boundary for templates, as `DiagramQuerySet.visible_to` is for diagrams.

        Four ways to see one, and the last is a restriction on the middle two rather than a
        route in:

          1. It is built in.
          2. You made it.
          3. Its author shared it with everyone at the company.
          4. ...but a template that still carries one workspace's data is shown only to
             someone who holds that workspace (its author always can, to manage it).
        """
        # A built-in an administrator has withdrawn is not offered to anyone -- see `Template.published`.
        builtin = models.Q(is_builtin=True, published=True)
        if principal is None:
            return self.filter(builtin)

        account_id = getattr(principal, "account_id", None)
        workspaces = set(getattr(principal, "connected_workspace_ids", None) or [])
        if account_id:
            from apps.auth_workspace.models import RememberedConnection

            workspaces |= set(
                RememberedConnection.objects.filter(account_id=account_id).values_list(
                    "workspace_id", flat=True
                )
            )

        shared = models.Q(shared_with_company=True) & (
            models.Q(locked_workspace_id="") | models.Q(locked_workspace_id__in=workspaces)
        )
        mine = models.Q(owner_id=account_id) if account_id else models.Q(pk__in=[])
        return self.filter(builtin | mine | shared)


class Template(models.Model):
    """
    A reference architecture: built in (seeded from fixtures), or saved by a person from one of
    their own diagrams.

    Nodes in a template graph carry `bound: false` plus a `binds` hint describing
    what real component may be bound to them.
    """

    objects = TemplateQuerySet.as_manager()

    key = models.SlugField(max_length=64, primary_key=True)
    # Null for a built-in. Cascades: a person's templates go with their account, like their diagrams.
    owner = models.ForeignKey(
        "accounts.Account",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="templates",
    )
    # Private unless the author says otherwise.
    shared_with_company = models.BooleanField(default=False)
    # Set when the graph still carries a workspace's own data -- ids, links -- and so only makes
    # sense for that workspace. Blank means generic: usable from any workspace. Always computed
    # from the graph on the server, never taken from the request.
    locked_workspace_id = models.CharField(max_length=64, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True, null=True)
    name = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    category = models.CharField(max_length=64, blank=True)
    graph = models.JSONField(default=dict)
    is_builtin = models.BooleanField(default=True)
    sort_order = models.IntegerField(default=0)
    # Whether a built-in is offered in everyone's Reference architectures. An administrator's switch:
    # re-seeding never touches it, so withdrawing a shipped template survives the next deploy.
    published = models.BooleanField(default=True)

    class Meta:
        ordering = ["sort_order", "name"]

    def __str__(self):
        return self.name

    def save(self, *args, **kwargs):
        # A built-in is seeded from our own fixture; anything else came from a person's browser.
        if not self.is_builtin:
            self.graph = sanitize_graph(self.graph or {})
        super().save(*args, **kwargs)

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

    # The label of the tab group it was saved from, so the Open dialog can list diagrams under
    # their group and reopen the group together. A label, not a key: blank means ungrouped.
    group_name = models.CharField(max_length=80, blank=True, default="")

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
