"""
Two caches, both in Postgres. No Redis -- that would be a second Render service
for data that is either near-static or safely re-fetchable.

* CatalogComponent: the *global* Segment catalog (every source/destination/
  warehouse type that exists). Workspace-independent, changes rarely, synced by
  the `sync_catalog` management command. The palette reads only from here, so
  browsing components never consumes the customer's API rate budget.

* WorkspaceResourceCache: per-workspace live data (their actual sources,
  audiences, and so on). Short TTL. This exists because of the rate limits --
  Space Schema allows 25 requests/minute, and a canvas render can easily want
  more than that.
"""

from datetime import timedelta

from django.contrib.postgres.fields import ArrayField
from django.db import models
from django.utils import timezone


class CatalogComponentQuerySet(models.QuerySet):
    def sources(self):
        return self.filter(kind=CatalogComponent.SOURCE)

    def destinations(self):
        return self.filter(kind=CatalogComponent.DESTINATION)

    def warehouses(self):
        return self.filter(kind=CatalogComponent.WAREHOUSE)


class CatalogComponent(models.Model):
    SOURCE = "source"
    DESTINATION = "destination"
    WAREHOUSE = "warehouse"
    KIND_CHOICES = [
        (SOURCE, "Source"),
        (DESTINATION, "Destination"),
        (WAREHOUSE, "Warehouse"),
    ]

    kind = models.CharField(max_length=16, choices=KIND_CHOICES, db_index=True)
    metadata_id = models.CharField(max_length=255)
    slug = models.SlugField(max_length=255)
    name = models.CharField(max_length=255)
    description = models.TextField(blank=True)
    categories = ArrayField(models.CharField(max_length=64), default=list, blank=True)
    logo_url = models.URLField(max_length=1024, blank=True)
    docs_url = models.URLField(max_length=1024, blank=True)
    # Full upstream payload, so a new field can be surfaced without a re-sync.
    raw = models.JSONField(default=dict, blank=True)
    synced_at = models.DateTimeField(auto_now=True)

    objects = CatalogComponentQuerySet.as_manager()

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["kind", "metadata_id"], name="uniq_catalog_component"
            )
        ]
        indexes = [
            models.Index(fields=["kind", "slug"]),
            models.Index(fields=["kind", "name"]),
        ]
        ordering = ["kind", "name"]

    def __str__(self):
        return f"{self.kind}:{self.slug}"


class WorkspaceResourceCache(models.Model):
    """
    One row per (workspace, resource_type).

    `resource_type` is scoped where a resource is space-specific, e.g.
    "audiences:spa_123" or "space_events:spa_123", so two spaces do not collide.
    """

    workspace_id = models.CharField(max_length=64, db_index=True)
    resource_type = models.CharField(max_length=128)
    payload = models.JSONField()
    fetched_at = models.DateTimeField(auto_now=True)
    expires_at = models.DateTimeField(db_index=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["workspace_id", "resource_type"], name="uniq_ws_resource"
            )
        ]

    def __str__(self):
        return f"{self.workspace_id}/{self.resource_type}"

    @property
    def is_fresh(self) -> bool:
        return self.expires_at > timezone.now()

    @classmethod
    def get_fresh(cls, workspace_id: str, resource_type: str):
        """Return the cached payload if still fresh, else None."""
        row = cls.objects.filter(
            workspace_id=workspace_id,
            resource_type=resource_type,
            expires_at__gt=timezone.now(),
        ).first()
        return row.payload if row else None

    @classmethod
    def put(cls, workspace_id: str, resource_type: str, payload, ttl_seconds: int):
        cls.objects.update_or_create(
            workspace_id=workspace_id,
            resource_type=resource_type,
            defaults={
                "payload": payload,
                "expires_at": timezone.now() + timedelta(seconds=ttl_seconds),
            },
        )

    @classmethod
    def purge_expired(cls) -> int:
        deleted, _ = cls.objects.filter(expires_at__lte=timezone.now()).delete()
        return deleted
