"""
Deep links: Segment documentation, and the customer's own workspace.

Every component on the canvas links to both. Docs URLs are stable published
paths under twilio.com/docs and can be trusted.

Workspace URLs are a different matter. Only the source path is corroborated:

    https://app.segment.com/{workspace_slug}/sources/{source_slug}

The Segment app's other routes are not part of any documented, versioned
contract. The rest of WORKSPACE_URL_TEMPLATES below is a best guess, each marked
UNVERIFIED. They are deliberately collected here, in one dict, so that checking
them against a real workspace is a single pass through one file and a correction
is a one-line edit -- rather than a hunt through view code.

If you are verifying these: open a real workspace, navigate to each resource
type, and compare. Change the template and drop the UNVERIFIED marker.
"""

APP_BASE = "https://app.segment.com"
DOCS_BASE = "https://www.twilio.com/docs/segment"

# --- Documentation ----------------------------------------------------------
# Static per-kind entry points. Every URL below was requested and returns 200
# without a redirect. Two of them used to redirect and were corrected in place:
# /unify/traits landed on /unify (indistinguishable from the "space" entry), and
# /protocols/tracking-plan landed on /protocols/tracking-plan/create.
DOCS_URL_TEMPLATES = {
    "source": f"{DOCS_BASE}/connections/sources/catalog",
    "cloud_source": f"{DOCS_BASE}/connections/sources/about-cloud-sources",
    "destination": f"{DOCS_BASE}/connections/destinations/catalog",
    "warehouse": f"{DOCS_BASE}/connections/storage",
    "destination_filter": f"{DOCS_BASE}/connections/destinations/destination-filters",
    "reverse_etl_model": f"{DOCS_BASE}/connections/reverse-etl/setup",
    "reverse_etl_catalog": f"{DOCS_BASE}/connections/reverse-etl/reverse-etl-catalog",
    "source_function": f"{DOCS_BASE}/connections/functions/source-functions",
    "source_insert_function": f"{DOCS_BASE}/connections/functions/source-insert-functions",
    "destination_function": f"{DOCS_BASE}/connections/functions/destination-functions",
    "destination_insert_function": f"{DOCS_BASE}/connections/functions/insert-functions",
    "profile_api": f"{DOCS_BASE}/unify/profile-api",
    "space": f"{DOCS_BASE}/unify",
    "identity_resolution": f"{DOCS_BASE}/unify/identity-resolution",
    # Space setup is the page that covers which sources feed a space, which is the
    # thing a Profile Source node records.
    "profile_source": f"{DOCS_BASE}/unify/identity-resolution/space-setup",
    # External IDs, not the Profile API: a profile node shows identifiers, traits
    # and events, and the identifiers are the part people need explained.
    "profile": f"{DOCS_BASE}/unify/identity-resolution/externalids",
    "identity_setting": (
        f"{DOCS_BASE}/unify/identity-resolution/identity-resolution-settings"
    ),
    "computed_trait": f"{DOCS_BASE}/unify/traits/computed-traits",
    "audience": f"{DOCS_BASE}/engage/audiences",
    "journey": f"{DOCS_BASE}/engage/journeys",
    "tracking_plan": f"{DOCS_BASE}/protocols/tracking-plan/create",
    # One page documents both library types, so both kinds point at it. Splitting
    # them across an #event-libraries / #property-libraries anchor was tried and
    # dropped: the fragment is not part of the published contract either, and a
    # fragment that stops matching lands the reader at the top of the page anyway.
    "event_library": f"{DOCS_BASE}/protocols/tracking-plan/libraries",
    "property_library": f"{DOCS_BASE}/protocols/tracking-plan/libraries",
    # The source's own Schema page, not a Protocols page: schema controls are a
    # setting on the source, and are what a tracking plan is enforced *through*.
    # /protocols/enforce-with-schema-controls and /protocols/schema both 404.
    "source_schema_control": f"{DOCS_BASE}/connections/sources/schema",
    "destination_mapping": f"{DOCS_BASE}/connections/destinations/actions",
    "profile_sync": f"{DOCS_BASE}/unify/profiles-sync/overview",
}

# Docs for a *region* of the diagram rather than a component in it.
#
# There used to be a `segment_core` kind whose only real job was to be the thing you
# right-clicked to ask "what does Segment itself do in the middle?". The component is
# gone; the question is not, so the affordance moved to the zone that replaced it.
# Sub-zones deliberately have no entry of their own: Profiles is documented by the
# Unify page, and a link that lands somewhere less specific than the reader expected
# is worse than no link.
ZONE_DOCS_URLS = {
    "segment": f"{DOCS_BASE}/connections",
    "connections": f"{DOCS_BASE}/connections",
    # The exception to the no-sub-zone-links rule above, and it earns it: Protocols
    # is a separate product with its own overview page, not a region of Connections
    # that the Connections page already covers.
    "protocols": f"{DOCS_BASE}/protocols",
    "unify": f"{DOCS_BASE}/unify",
    "engage": f"{DOCS_BASE}/engage",
}


def zone_docs_url(zone_id: str) -> str | None:
    return ZONE_DOCS_URLS.get(zone_id)


# Per-slug catalog pages, where a specific integration has its own doc page.
#
# Destinations only. Source doc pages are nested one level deeper, by category
# --  /sources/catalog/libraries/website/javascript, /libraries/mobile/ios,
# /libraries/server/node, /cloud-apps/salesforce -- so a bare slug cannot build a
# valid URL (/sources/catalog/javascript 404s, checked). The category segment is
# not derivable from anything the catalog API returns with confidence, so sources
# fall through to the catalog index in DOCS_URL_TEMPLATES rather than to a guess.
DOCS_CATALOG_TEMPLATES = {
    "destination": f"{DOCS_BASE}/connections/destinations/catalog/{{slug}}",
}

# --- Customer workspace -----------------------------------------------------
WORKSPACE_URL_TEMPLATES = {
    # VERIFIED
    "source": f"{APP_BASE}/{{workspace_slug}}/sources/{{slug}}",
    # UNVERIFIED -- check against a real workspace before trusting.
    "source_overview": f"{APP_BASE}/{{workspace_slug}}/sources",
    "destination": f"{APP_BASE}/{{workspace_slug}}/destinations/{{slug}}",
    "destination_overview": f"{APP_BASE}/{{workspace_slug}}/destinations",
    "warehouse": f"{APP_BASE}/{{workspace_slug}}/warehouses/{{resource_id}}",
    "destination_filter": (
        f"{APP_BASE}/{{workspace_slug}}/destinations/{{slug}}/filters"
    ),
    "function": f"{APP_BASE}/{{workspace_slug}}/functions/{{resource_id}}",
    "source_function": f"{APP_BASE}/{{workspace_slug}}/functions/{{resource_id}}",
    "destination_function": f"{APP_BASE}/{{workspace_slug}}/functions/{{resource_id}}",
    "reverse_etl_model": (
        f"{APP_BASE}/{{workspace_slug}}/reverse-etl/models/{{resource_id}}"
    ),
    "space": f"{APP_BASE}/{{workspace_slug}}/unify/spaces/{{space_id}}",
    "identity_resolution": (
        f"{APP_BASE}/{{workspace_slug}}/unify/spaces/{{space_id}}/identity-resolution"
    ),
    "computed_trait": (
        f"{APP_BASE}/{{workspace_slug}}/unify/spaces/{{space_id}}/computed-traits/"
        "{resource_id}"
    ),
    "audience": (
        f"{APP_BASE}/{{workspace_slug}}/engage/spaces/{{space_id}}/audiences/"
        "{resource_id}"
    ),
    "journey": f"{APP_BASE}/{{workspace_slug}}/engage/spaces/{{space_id}}/journeys",
    "tracking_plan": f"{APP_BASE}/{{workspace_slug}}/protocols/tracking-plans/{{resource_id}}",
}

# Deliberately absent from the table above: event_library, property_library,
# source_schema_control, destination_mapping, profile_sync. Each of them lives on a
# tab of a resource whose own template is already a guess, so a template for them
# would be a guess built on a guess -- and `workspace_url` returning None costs one
# missing link, where a wrong one costs the reader a 404 they blame on the workspace.

# Kinds whose workspace URL template has not been confirmed against the live app.
UNVERIFIED_KINDS = frozenset(WORKSPACE_URL_TEMPLATES) - {"source"}


def docs_url(kind: str, *, slug: str | None = None) -> str | None:
    """
    Documentation URL for a component kind.

    Prefers the integration-specific catalog page when a slug is known, since
    that is far more useful than the catalog index.
    """
    if slug and kind in DOCS_CATALOG_TEMPLATES:
        return DOCS_CATALOG_TEMPLATES[kind].format(slug=slug)
    return DOCS_URL_TEMPLATES.get(kind)


def workspace_url(
    kind: str,
    *,
    workspace_slug: str,
    slug: str | None = None,
    resource_id: str | None = None,
    space_id: str | None = None,
) -> str | None:
    """
    Link into the customer's own Segment workspace.

    Returns None when the template needs a value we do not have, rather than
    emitting a URL with a literal "{resource_id}" in it -- a missing link is
    better than a broken one.
    """
    template = WORKSPACE_URL_TEMPLATES.get(kind)
    if not template or not workspace_slug:
        return None
    try:
        return template.format(
            workspace_slug=workspace_slug,
            slug=slug or "",
            resource_id=resource_id or "",
            space_id=space_id or "",
        )
    except KeyError:
        return None


def is_verified(kind: str) -> bool:
    """Whether this kind's workspace URL has been confirmed against the live app."""
    return kind not in UNVERIFIED_KINDS
