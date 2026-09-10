"""What the form is allowed to send, and what this app derives from it."""

from datetime import datetime, timezone

from rest_framework import serializers

from . import airtable
from .titles import problem_title

# A ceiling per file and on the total. Airtable's own limit is larger, but a screenshot of a diagram is
# well under a megabyte and the reason to cap is this app's own memory: an attachment is base64-encoded
# in full before being sent, so an unbounded upload is an unbounded allocation in a web worker.
MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
MAX_ATTACHMENTS = 5


class FeedbackSerializer(serializers.Serializer):
    """
    The four fields the user fills in. Everything else is derived -- see `to_fields`.

    `proposed_fix`, `reporter` and attachments are optional, deliberately. The one thing a feedback form
    must not do is refuse a report because the reporter had no fix to propose or did not want to leave
    their name; the description is the whole of what is needed.
    """

    description = serializers.CharField(
        trim_whitespace=True,
        max_length=10_000,
        help_text="What went wrong.",
    )
    proposed_fix = serializers.CharField(
        required=False, allow_blank=True, trim_whitespace=True, max_length=10_000
    )
    reporter = serializers.CharField(
        required=False, allow_blank=True, trim_whitespace=True, max_length=200
    )

    def validate_description(self, value):
        # A description of pure whitespace passes `CharField` once trimmed to empty only if
        # allow_blank; it does not here, but a description of "." would. Guarded because the title is
        # derived from it and a record whose title is "Untitled feedback" is one nobody triages.
        if len(value.strip()) < 10:
            raise serializers.ValidationError(
                "Please say a little more — ten characters or so, enough to recognise the problem later."
            )
        return value

    def to_fields(self, *, app_name: str) -> dict:
        """
        The Airtable record.

        The four derived fields are computed here rather than defaulted in Airtable, so they are true of
        *this* submission: a base-level default for `Submitted At` would be the time Airtable processed
        the write, which is close enough to be indistinguishable and wrong under a retry.
        """
        data = self.validated_data
        description = data["description"]

        fields = {
            airtable.FIELD_TITLE: problem_title(description),
            airtable.FIELD_DESCRIPTION: description,
            airtable.FIELD_SUBMITTED_AT: (
                # UTC, as asked, and ISO-8601 with an explicit `Z`. Airtable parses a naive timestamp as
                # the base's own timezone, so omitting the offset would silently shift every record by
                # however many hours the base is configured for.
                datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
            ),
            airtable.FIELD_STATUS: airtable.STATUS_NEW,
            airtable.FIELD_APP: app_name,
        }

        # Omitted rather than written empty. An empty string in a single-line-text field is
        # indistinguishable from a filled-in blank, and in a single-select it can create an empty
        # option; a missing key leaves the cell genuinely untouched.
        if data.get("proposed_fix"):
            fields[airtable.FIELD_PROPOSED_FIX] = data["proposed_fix"]
        if data.get("reporter"):
            fields[airtable.FIELD_REPORTER] = data["reporter"]

        return fields
