"""
Serializers for the catalog palette.

Workspace resources are *not* serialized here -- they arrive from the Segment
API as dicts and are shaped by `apps.segmentapi.schemas`, which is also where
write-key masking happens. Running them through a DRF serializer as well would
mean two places to keep in step.
"""

from rest_framework import serializers

from .models import CatalogComponent


class CatalogComponentSerializer(serializers.ModelSerializer):
    """
    Palette entry.

    Field names are camelCased to match the workspace-resource dicts that
    `apps.segmentapi.schemas` produces. Both end up in the same palette, and one
    wire convention is worth the four aliases.

    `raw` is deliberately excluded: it is a few KB per row of upstream payload
    kept for forward-compatibility, and sending hundreds of them would dominate
    the response.
    """

    metadataId = serializers.CharField(source="metadata_id", read_only=True)
    logoUrl = serializers.CharField(source="logo_url", read_only=True)
    docsUrl = serializers.CharField(source="docs_url", read_only=True)

    class Meta:
        model = CatalogComponent
        fields = [
            "kind",
            "metadataId",
            "slug",
            "name",
            "description",
            "categories",
            "logoUrl",
            "docsUrl",
        ]
