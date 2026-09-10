"""
Deep-link templates.

These tests are offline on purpose. The URLs in deeplinks.py were checked against
the live docs site once, by hand, and what is worth pinning here is not "does
twilio.com serve a 200" -- that would make the suite fail on a Twilio outage --
but the three specific conclusions that check produced, each of which a future
edit could quietly undo.
"""

from apps.segmentapi import deeplinks


def test_source_does_not_get_a_per_slug_docs_page():
    """
    /connections/sources/catalog/javascript is a 404.

    Source doc pages nest by category (/catalog/libraries/website/javascript),
    and the category is not recoverable from the catalog payload, so a source
    must fall through to the catalog index rather than build a broken URL.
    """
    assert deeplinks.docs_url("source", slug="javascript") == deeplinks.docs_url("source")
    assert deeplinks.docs_url("source").endswith("/connections/sources/catalog")


def test_destination_does_get_a_per_slug_docs_page():
    assert deeplinks.docs_url("destination", slug="braze").endswith(
        "/connections/destinations/catalog/braze"
    )


def test_computed_trait_docs_are_distinct_from_the_space_entry_point():
    """
    /unify/traits redirects to /unify, which made these two kinds link to the
    same page while looking like they linked to different ones.
    """
    assert deeplinks.docs_url("computed_trait") != deeplinks.docs_url("space")
    assert deeplinks.docs_url("computed_trait").endswith("/unify/traits/computed-traits")


def test_tracking_plan_docs_point_at_the_page_that_actually_serves():
    assert deeplinks.docs_url("tracking_plan").endswith("/protocols/tracking-plan/create")


def test_unknown_kind_has_no_docs_page():
    assert deeplinks.docs_url("not_a_kind") is None
    assert deeplinks.docs_url("not_a_kind", slug="whatever") is None


def test_every_docs_template_is_an_absolute_docs_url():
    for kind, url in deeplinks.DOCS_URL_TEMPLATES.items():
        assert url.startswith("https://www.twilio.com/docs/segment/"), kind
        assert "{" not in url, kind


def test_every_component_kind_has_a_docs_page():
    """
    The Links tab is on every node, so a kind with no docs URL renders a tab whose
    only content is an apology. Cheap to keep complete; easy to forget when adding
    a kind to topology.py.
    """
    from apps.segmentapi import topology

    for kind in topology.KINDS:
        assert deeplinks.docs_url(kind), kind


def test_workspace_url_needs_a_slug():
    assert deeplinks.workspace_url("source", workspace_slug="") is None


def test_workspace_url_fills_every_placeholder():
    url = deeplinks.workspace_url(
        "audience",
        workspace_slug="acme",
        resource_id="aud_1",
        space_id="spa_1",
    )
    assert "{" not in url
    assert url == "https://app.segment.com/acme/engage/spaces/spa_1/audiences/aud_1"


def test_only_the_source_workspace_url_claims_to_be_verified():
    """
    The honesty of the CircleHelp badge in the inspector's Links tab depends on
    this staying accurate. Dropping a kind from UNVERIFIED_KINDS is a claim that
    someone opened a real workspace and confirmed it.
    """
    assert deeplinks.is_verified("source")
    assert not deeplinks.is_verified("audience")
    assert not deeplinks.is_verified("space")
