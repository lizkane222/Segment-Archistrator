"""
Diagrams and templates.

`graph` holds the whole React Flow document as JSONB: {nodes, edges, viewport}.
Relational node/edge tables were considered and rejected -- the graph is always
read and written as a unit, nothing ever queries an individual node, so tables
would add joins for no benefit.
"""

import re
import uuid

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
    def for_workspace(self, workspace_id: str):
        """The authorization boundary. Every read must go through this."""
        return self.filter(workspace_id=workspace_id)

    def reassign_workspace(self, *, from_id: str, to_id: str) -> int:
        """
        Move diagrams from one scope to another. Returns how many moved.

        Exists for one caller: a visitor who drew something before connecting, then
        pasted a token. Their work is scoped to the anonymous session, and without
        this it would sit in a scope nothing can reach again once that cookie is
        replaced.

        Deliberately not a general "share a diagram" primitive. The caller must
        already hold the cookie for `from_id`, which is the only thing making this
        safe -- there is no other proof of ownership over an anonymous scope.
        """
        if not from_id or not to_id or from_id == to_id:
            return 0
        # update(), not a save() loop: sanitize_graph has already run on every one
        # of these rows on the way in, and re-running it would rewrite JSONB for no
        # reason on a request the user is waiting on.
        return self.filter(workspace_id=from_id).update(workspace_id=to_id)


class Diagram(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    # Scoping key, not a foreign key: sessions come and go, diagrams outlive them.
    workspace_id = models.CharField(max_length=64, db_index=True)

    name = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    graph = models.JSONField(default=dict)
    source_template = models.CharField(max_length=64, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    objects = DiagramQuerySet.as_manager()

    class Meta:
        indexes = [models.Index(fields=["workspace_id", "-updated_at"])]
        ordering = ["-updated_at"]

    def __str__(self):
        return f"{self.name} ({self.workspace_id})"

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
