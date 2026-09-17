"""
The feedback form's wire contract, and what a submission actually writes.

## Why the first test reads a `.js` file

The browser and the serializer have to agree on the names of the form's fields, and nothing makes them:
DRF ignores an input key it does not recognise, and every field but `description` is optional. So a form
that posted `proposedFix` where the serializer expects `proposed_fix` would validate, submit, return 200
and land in Airtable with that column empty -- the same silent-success failure mode the
`airtable_schema` command exists to catch on the *Airtable* side of the same write. This is that check
for the *browser* side, and it is the reason to reach across into `frontend/` rather than test the two
halves separately and assume they meet.
"""

import re
from datetime import datetime
from pathlib import Path

import pytest

from apps.feedback import airtable
from apps.feedback.serializers import FeedbackSerializer

API_JS = Path(__file__).resolve().parents[1] / "frontend" / "src" / "services" / "api.js"

# `body.append('name', ...)` inside `feedback.submit`, either quote style.
_APPEND = re.compile(r"body\.append\(\s*['\"]([^'\"]+)['\"]")

# The one key that is deliberately not a serializer field: files are read off the request by the view,
# not declared on the serializer, because DRF's FileField cannot express "zero or more of these".
UPLOAD_KEY = "attachments"


def _submit_keys() -> set[str]:
    source = API_JS.read_text()
    # Just the `submit` function, so an `append` belonging to some other request cannot be picked up.
    start = source.index("submit: (")
    body = source[start : source.index("\n  },", start)]
    return set(_APPEND.findall(body))


def test_the_form_and_the_serializer_agree_on_field_names():
    posted = _submit_keys()
    assert posted, f"found no body.append calls in {API_JS} -- has submit been rewritten?"

    declared = set(FeedbackSerializer().fields) | {UPLOAD_KEY}
    unknown = posted - declared
    assert not unknown, (
        f"{API_JS.name} posts {sorted(unknown)}, which the serializer does not declare. DRF drops an "
        "unknown key silently, so this would submit successfully and store nothing for that field."
    )
    assert "description" in posted, "the one required field is not being sent"


def test_every_field_the_form_can_send_reaches_airtable():
    """The other direction: a declared field nobody writes is a field quietly going nowhere."""
    serializer = FeedbackSerializer(
        data={
            "description": "The walkthrough leaves every zone dimmed after it finishes",
            "proposed_fix": "Clear it when the transport stops.",
            "reporter": "someone@example.com",
        }
    )
    assert serializer.is_valid(), serializer.errors
    fields = serializer.to_fields(app_name="Segment Archistrator")

    assert fields[airtable.FIELD_PROPOSED_FIX] == "Clear it when the transport stops."
    assert fields[airtable.FIELD_REPORTER] == "someone@example.com"
    # Every field the app claims to write, present on a fully-filled submission. Attachments excluded:
    # they are uploaded to the record afterwards rather than written as a field -- see airtable.py.
    assert set(airtable.WRITTEN_FIELDS) == set(fields)


def test_the_derived_fields_are_not_the_reporters_to_set():
    """
    Status, title, timestamp and app name are derived, so a submission cannot choose them.

    Sent as inputs they must be ignored rather than honoured: "the remaining fields will be manually
    maintained by my team", and a form that let a reporter file their own report as `Done` would quietly
    remove it from the team's triage view.
    """
    serializer = FeedbackSerializer(
        data={
            "description": "Connectors overlap badly when three arrive at one node",
            "status": "Done",
            "Status": "Done",
            "App": "Something Else",
            "submitted_at": "1999-01-01T00:00:00Z",
            "problem_title": "chosen by hand",
        }
    )
    assert serializer.is_valid(), serializer.errors
    fields = serializer.to_fields(app_name="Segment Archistrator")

    assert fields[airtable.FIELD_STATUS] == airtable.STATUS_NEW
    assert fields[airtable.FIELD_APP] == "Segment Archistrator"
    assert fields[airtable.FIELD_TITLE] == "Connectors overlap badly when three"
    assert not fields[airtable.FIELD_SUBMITTED_AT].startswith("1999")


def test_the_timestamp_is_utc_and_says_so():
    """
    An explicit `Z`, because Airtable reads a naive timestamp as the *base's* timezone.

    Without the offset every record would be silently shifted by however many hours the base happens to
    be configured for -- wrong in a way that looks plausible, which is the worst kind.
    """
    serializer = FeedbackSerializer(data={"description": "Something went wrong on the canvas"})
    assert serializer.is_valid(), serializer.errors
    stamp = serializer.to_fields(app_name="X")[airtable.FIELD_SUBMITTED_AT]

    assert stamp.endswith("Z")
    parsed = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    assert parsed.utcoffset().total_seconds() == 0
    assert parsed.microsecond == 0


@pytest.mark.parametrize("blank", ["", "   "])
def test_an_omitted_optional_field_is_absent_rather_than_empty(blank):
    """
    A missing key leaves the Airtable cell untouched; an empty string fills it in with nothing.

    They are not the same: a blank single-line-text cell reads as "someone answered and had nothing to
    say", and the point of the optional fields is that not answering is allowed.
    """
    serializer = FeedbackSerializer(
        data={"description": "The zones stay dimmed after the walkthrough", "proposed_fix": blank}
    )
    assert serializer.is_valid(), serializer.errors
    assert airtable.FIELD_PROPOSED_FIX not in serializer.to_fields(app_name="X")


def test_a_description_too_short_to_recognise_is_refused():
    serializer = FeedbackSerializer(data={"description": "broken"})
    assert not serializer.is_valid()
    assert "description" in serializer.errors


def test_the_single_selects_only_ever_write_a_value_the_base_has():
    """
    `fixed_values` is what `manage.py airtable_schema` checks against the base's own options.

    It has to name every single-select constant this app writes, or the schema check passes while the
    write invents a new option -- so the two are pinned to each other here.
    """
    values = airtable.fixed_values()
    assert values[airtable.FIELD_STATUS] == airtable.STATUS_NEW
    assert set(values) <= set(airtable.WRITTEN_FIELDS)
