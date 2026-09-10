"""
Normalizers and masking.

The write-key tests here are the second half of the security requirement: the
token is protected by encryption, and write keys are protected by never being
serialized in the first place.

The audience tests exist because the real capture in ../audience-list.json and
the published docs sample disagree about the shape. Both must parse.
"""

from apps.segmentapi import schemas

SLUG = "acme-corp"


# --- masking ----------------------------------------------------------------

def test_mask_keeps_only_the_last_four():
    masked = schemas.mask_write_key("wk_abcdefghijklmnop1234")
    assert masked.endswith("1234")
    assert "abcdefghij" not in masked


def test_mask_handles_missing_and_short_values():
    assert schemas.mask_write_key(None) is None
    assert schemas.mask_write_key("") is None
    # Nothing recoverable from a short key either.
    assert "abc" not in schemas.mask_write_key("abc")


def test_source_node_never_carries_the_raw_write_key():
    raw = {
        "id": "src_1",
        "slug": "website",
        "name": "Website",
        "writeKey": "SUPERSECRETWRITEKEY9999",
        "metadata": {"slug": "javascript"},
    }
    node = schemas.normalize_source(raw, workspace_slug=SLUG)
    assert "SUPERSECRETWRITEKEY9999" not in str(node)
    assert "writeKey" not in node
    assert node["writeKeyMasked"].endswith("9999")


# --- sources ----------------------------------------------------------------

def test_source_type_comes_from_metadata_slug():
    node = schemas.normalize_source(
        {"id": "src_1", "slug": "app", "metadata": {"slug": "ios"}}, workspace_slug=SLUG
    )
    assert node["sourceType"] == "ios"
    assert node["zone"] == "connections"


def test_unrecognised_source_type_falls_back_to_http():
    """Segment adds source types; an unknown one should still render."""
    node = schemas.normalize_source(
        {"id": "src_1", "metadata": {"slug": "quantum-toaster"}}, workspace_slug=SLUG
    )
    assert node["sourceType"] == "http"
    # But the real value is kept, so the inspector can still show the truth.
    assert node["sourceTypeRaw"] == "quantum-toaster"


def test_source_survives_an_empty_payload():
    node = schemas.normalize_source({}, workspace_slug=SLUG)
    assert node["kind"] == "source"
    assert node["name"] == "Untitled source"


def test_source_gets_both_deep_links():
    node = schemas.normalize_source(
        {"id": "src_1", "slug": "website", "metadata": {"slug": "javascript"}},
        workspace_slug=SLUG,
    )
    assert node["workspaceUrl"] == "https://app.segment.com/acme-corp/sources/website"
    assert node["docsUrl"].startswith("https://www.twilio.com/docs/segment/")
    # Source is the one verified workspace URL template.
    assert node["linkVerified"] is True


def test_unverified_kinds_are_flagged_as_such():
    """
    Only the source path is corroborated. Everything else is a guess, and the UI
    needs to know which is which rather than presenting all links as equal.
    """
    node = schemas.normalize_destination(
        {"id": "dst_1", "name": "Braze", "metadata": {"slug": "braze"}}, workspace_slug=SLUG
    )
    assert node["linkVerified"] is False


# --- destinations and filters -----------------------------------------------

def test_destination_carries_categories_for_the_palette_filters():
    node = schemas.normalize_destination(
        {
            "id": "dst_1",
            "name": "Braze",
            "sourceId": "src_1",
            "metadata": {"slug": "braze", "categories": ["CRM", "Email"]},
        },
        workspace_slug=SLUG,
    )
    assert node["categories"] == ["CRM", "Email"]
    assert node["sourceId"] == "src_1"


def test_destination_filter_keeps_the_condition_for_the_simulator():
    node = schemas.normalize_destination_filter(
        {"id": "f_1", "title": "Drop internal", "if": 'event = "Debug"', "enabled": True},
        workspace_slug=SLUG,
        destination_id="dst_1",
    )
    assert node["condition"] == 'event = "Debug"'
    assert node["destinationId"] == "dst_1"
    assert node["zone"] == "connections"


# --- functions --------------------------------------------------------------

def test_function_kind_follows_resource_type():
    def kind_for(resource_type):
        return schemas.normalize_function(
            {"id": "fn_1", "displayName": "F", "resourceType": resource_type},
            workspace_slug=SLUG,
        )["kind"]

    assert kind_for("SOURCE") == "source_function"
    assert kind_for("DESTINATION") == "destination_function"
    assert kind_for("INSERT_DESTINATION") == "destination_insert_function"


# --- audiences: both observed shapes ---------------------------------------

def test_audience_parses_the_real_capture_shape():
    """Shape from ../audience-list.json: prefixed ids, definition + options."""
    node = schemas.normalize_audience(
        {
            "id": "aud_abc123",
            "spaceId": "spa_xyz",
            "name": "High value",
            "key": "high_value",
            "enabled": True,
            "status": "Live",
            "definition": {"query": 'event("Order Completed").count() >= 3', "type": "USERS"},
            "options": {"includeAnonymousUsers": True, "includeHistoricalData": False},
        },
        workspace_slug=SLUG,
        space_id="spa_xyz",
    )
    assert node["query"].startswith('event("Order Completed")')
    assert node["definitionType"] == "USERS"
    assert node["includeAnonymousUsers"] is True
    assert node["status"] == "Live"


def test_audience_parses_the_docs_sample_shape():
    """Docs shape: bare id, audienceType/size/computeCadence, no options."""
    node = schemas.normalize_audience(
        {
            "id": "abcdefghijklmnopqrstuv",
            "name": "Docs sample",
            "audienceType": "ACCOUNTS",
            "size": 4200,
        },
        workspace_slug=SLUG,
        space_id="spa_xyz",
    )
    assert node["audienceType"] == "ACCOUNTS"
    assert node["size"] == 4200
    # Missing fields default rather than raising.
    assert node["includeAnonymousUsers"] is False
    assert node["query"] == ""


def test_audience_survives_an_empty_payload():
    node = schemas.normalize_audience({}, workspace_slug=SLUG, space_id="spa_1")
    assert node["kind"] == "audience"
    assert node["zone"] == "engage"


# --- journeys: inference only ----------------------------------------------

def test_journeys_are_inferred_from_the_trait_naming_convention():
    traits = [
        {"key": "j_o_welcome_series__step_1_a1b2c"},
        {"key": "j_o_welcome_series__step_2_d3e4f"},
        {"key": "j_o_winback__reengage_9z8y7"},
        {"key": "lifetime_order_value"},  # an ordinary trait
    ]
    journeys = schemas.infer_journeys_from_traits(traits)

    assert [j["slug"] for j in journeys] == ["welcome_series", "winback"]
    assert len(journeys[0]["steps"]) == 2


def test_inferred_journeys_admit_what_they_do_not_know():
    """
    Step order is not recoverable from the naming convention, and the whole thing
    is a guess. Both facts have to travel with the data, or the UI will present a
    heuristic as a finding.
    """
    journeys = schemas.infer_journeys_from_traits(
        [{"key": "j_o_welcome__step_1_a1b2c"}]
    )
    assert journeys[0]["inferred"] is True
    assert journeys[0]["steps"][0]["orderKnown"] is False


def test_journey_step_traits_are_flagged_on_the_trait_itself():
    node = schemas.normalize_computed_trait(
        {"id": "t_1", "name": "Step", "key": "j_o_welcome__step_1_a1b2c"},
        workspace_slug=SLUG,
        space_id="spa_1",
    )
    assert node["isJourneyStep"] is True

    ordinary = schemas.normalize_computed_trait(
        {"id": "t_2", "name": "LTV", "key": "lifetime_value"},
        workspace_slug=SLUG,
        space_id="spa_1",
    )
    assert ordinary["isJourneyStep"] is False


def test_inference_returns_nothing_when_there_is_nothing_to_infer():
    assert schemas.infer_journeys_from_traits([]) == []
    assert schemas.infer_journeys_from_traits([{"key": "plain_trait"}]) == []


# --- catalog ----------------------------------------------------------------

def test_catalog_entry_flattens_to_model_fields():
    fields = schemas.normalize_catalog_entry(
        {
            "id": "meta_1",
            "slug": "braze",
            "name": "Braze",
            "description": "Engagement",
            "categories": ["CRM"],
            "logos": {"default": "https://cdn/braze.svg"},
        },
        "destination",
    )
    assert fields["metadata_id"] == "meta_1"
    assert fields["logo_url"] == "https://cdn/braze.svg"
    assert fields["docs_url"].endswith("/catalog/braze")


def test_catalog_entry_tolerates_missing_logos():
    fields = schemas.normalize_catalog_entry({"id": "m", "slug": "s", "name": "N"}, "source")
    assert fields["logo_url"] == ""
    assert fields["categories"] == []
