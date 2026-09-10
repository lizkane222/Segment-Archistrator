"""
Nuances: what a Twilion knows about a component that the documentation does not say.

Known product gaps, known bugs, the ordering that only bites you once. The request's
framing is that this is *gathered from user input* -- so the model is a submission box,
not a curated content table, and Stage 6 adds the pass that makes a pile of submissions
succinct.

**There is no workspace_id, and that is the design.** A nuance is a fact about Segment,
not about a customer, and it is shown to everyone who right-clicks that kind of
component. If the row recorded which session submitted it, then "this breaks when the
customer has two spaces" would carry the identity of the customer who has two spaces --
into a table every other workspace reads. The submit form says as much, because the
model cannot enforce what someone types.

The cost of that is stated plainly rather than worked around: with no attribution there
can be no per-submitter rate limit and no way to remove one person's submissions. What
bounds abuse instead is the session requirement on POST (a visitor at least has a
cookie), the length cap in the serializer, and `status` -- a submission is visible but
can be hidden by hand, which is the only moderation lever a table with no authors can
have. Anything stronger would mean attribution, and attribution is the thing being
traded away on purpose.
"""

from django.db import models

from apps.segmentapi import topology


class NuanceQuerySet(models.QuerySet):
    def visible(self):
        """
        What a reader sees: everything except what has been hidden by hand.

        A queryset method rather than a filter in the view, so a second endpoint added
        later cannot forget it -- the same reasoning as masking in serializers rather
        than in views.
        """
        return self.exclude(status=Nuance.HIDDEN)

    def for_kind(self, kind: str):
        return self.filter(kind=kind)


class Nuance(models.Model):
    SUBMITTED = "submitted"
    PUBLISHED = "published"
    HIDDEN = "hidden"
    STATUS_CHOICES = [
        (SUBMITTED, "Submitted"),
        # Summarised and confirmed. Stage 6 is what promotes a row to this;
        # until then everything sits at `submitted` and is shown verbatim.
        (PUBLISHED, "Published"),
        (HIDDEN, "Hidden"),
    ]

    # The component *kind*, from the topology table -- not a component instance.
    # A nuance about destination filters is true of every destination, so keying
    # it to one node id would hide it from the next diagram that needs it.
    kind = models.CharField(max_length=64, db_index=True)
    # The catalog slug, for the narrower case: "Braze needs the SDK version set
    # before an identify will land". Blank means the nuance is about the kind
    # itself, which is the common one.
    slug = models.SlugField(max_length=255, blank=True)
    body = models.TextField()
    status = models.CharField(
        max_length=16, choices=STATUS_CHOICES, default=SUBMITTED, db_index=True
    )
    created_at = models.DateTimeField(auto_now_add=True)

    objects = NuanceQuerySet.as_manager()

    class Meta:
        # Newest first: a nuance about a product that shipped a fix last month is
        # less useful than one written this week, and nothing here ranks them.
        ordering = ["-created_at"]
        indexes = [models.Index(fields=["kind", "slug"])]

    def __str__(self) -> str:
        return f"{self.kind}{f'/{self.slug}' if self.slug else ''}: {self.body[:60]}"

    @staticmethod
    def known_kinds() -> set[str]:
        """
        The kinds a nuance may be filed against.

        Read from the topology rather than duplicated as `choices`, so a kind added
        there is submittable immediately and a typo'd one is refused. `custom` is
        included deliberately: it has no topology entry by design, and someone will
        have something to say about the components a customer runs themselves.
        """
        return set(topology.KINDS) | {"custom"}
