"""
Writing one feedback record to Airtable.

## Why this is server-side

The token has `data.records:write`. There is no way to put such a token in a browser bundle safely --
anyone who opens the network tab has it, and can then write whatever they like to the base. So the form
posts to this app and this app calls Airtable, which is the only arrangement where the token stays a
secret. That is the entire architectural reason `apps/feedback` exists rather than the form calling
Airtable directly.

## The field names

Written here as constants and *verified* by `manage.py airtable_schema`, because Airtable is silent
about a name it does not recognise: with `typecast: true` a write naming a field that has been renamed
succeeds, returns 200, and leaves that column empty. Nothing in the response says so. The management
command is what turns that into a loud failure at deploy time instead of a quiet one per submission.

## Attachments

Airtable's records API cannot accept file bytes -- an attachment field takes a *URL* it will go and
fetch. That would mean hosting the upload somewhere public first, which for a screenshot of a
customer's workspace is exactly wrong.

So attachments go through the separate upload endpoint
(`POST /v0/{baseId}/{recordId}/{field}/uploadAttachment`), which takes base64 content directly and is
covered by the same `data.records:write` scope. It needs the record to exist, so the order is: create
the record, then upload each file to it. A failed upload therefore leaves a real record with the
attachment missing, which is the right way round -- the description is the part worth keeping.
"""

import base64
import logging

import requests
import truststore
from django.conf import settings

truststore.inject_into_ssl()

logger = logging.getLogger(__name__)

API_BASE = "https://api.airtable.com/v0"
# The upload endpoint is on its own host, which is easy to miss in Airtable's docs and produces a
# confusing 404 against the main one.
UPLOAD_BASE = "https://content.airtable.com/v0"

DEFAULT_TIMEOUT = (5, 30)

# --- what this app writes ----------------------------------------------------

# The four the user fills in.
FIELD_DESCRIPTION = "Problem Description"
FIELD_PROPOSED_FIX = "Proposed Fix"
FIELD_ATTACHMENTS = "Attachments"
FIELD_REPORTER = "Reporter"

# The four this app fills in behind the form.
FIELD_TITLE = "Problem Title"
FIELD_SUBMITTED_AT = "Submitted At"
FIELD_STATUS = "Status"
FIELD_APP = "App"

STATUS_NEW = "New"

# Everything above, for the schema command to check. Attachments are excluded: they are not written as a
# *field* on create -- see the module docstring -- so a base without an attachment field can still take
# feedback, just without files.
WRITTEN_FIELDS = (
    FIELD_TITLE,
    FIELD_DESCRIPTION,
    FIELD_PROPOSED_FIX,
    FIELD_REPORTER,
    FIELD_SUBMITTED_AT,
    FIELD_STATUS,
    FIELD_APP,
)

# What each field has to be for the write to mean what it says. Several are lists because more than one
# Airtable type is a correct choice: a description reads fine as `multilineText` or `richText`, and a
# status works as a single select or as plain text.
FIELD_TYPES = {
    FIELD_TITLE: ("singleLineText",),
    FIELD_DESCRIPTION: ("multilineText", "richText", "singleLineText"),
    FIELD_PROPOSED_FIX: ("multilineText", "richText", "singleLineText"),
    FIELD_REPORTER: ("singleLineText", "multilineText", "email"),
    FIELD_SUBMITTED_AT: ("dateTime", "date"),
    FIELD_STATUS: ("singleSelect", "singleLineText"),
    FIELD_APP: ("singleSelect", "singleLineText"),
}


def fixed_values() -> dict:
    """
    The fields this app writes a *constant* into, and the constant.

    Both are single selects in the base, and `typecast` turns a value that matches no existing option
    into a *new option* rather than an error. So "New" against a base whose first status is called
    "Triage" would quietly grow a second, near-duplicate choice, and every report would land under it
    while the team's own views filtered on the old one. Checked by `manage.py airtable_schema` against
    the options the base actually has, which is the only place that mismatch is visible before it
    happens.

    A function rather than a dict constant because `AIRTABLE_APP_NAME` is a setting, and reading it at
    import time would freeze whatever it was when the module first loaded.
    """
    return {FIELD_STATUS: STATUS_NEW, FIELD_APP: settings.AIRTABLE_APP_NAME}


class AirtableNotConfigured(RuntimeError):
    """No token, or no base. The feedback form is unavailable rather than broken."""


class AirtableError(RuntimeError):
    """Airtable refused the write. Carries a message fit to show a user."""


class AirtableClient:
    def __init__(self, token: str, base_id: str = "", table: str = "Feedback"):
        self._token = token
        self.base_id = base_id
        self.table = table
        self._session = requests.Session()

    @classmethod
    def from_settings(cls, *, require_base: bool = True) -> "AirtableClient":
        token = settings.AIRTABLE_API_KEY
        if not token:
            raise AirtableNotConfigured(
                "AIRTABLE_API_KEY is not set, so feedback cannot be submitted."
            )
        base = settings.AIRTABLE_BASE_ID
        if require_base and not base:
            raise AirtableNotConfigured(
                "AIRTABLE_BASE_ID is not set. Run `manage.py airtable_schema` to list the bases the "
                "token can see."
            )
        return cls(token, base_id=base, table=settings.AIRTABLE_TABLE)

    @property
    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self._token}"}

    def _request(self, method: str, url: str, **kwargs) -> dict:
        try:
            response = self._session.request(
                method, url, headers=self._headers, timeout=DEFAULT_TIMEOUT, **kwargs
            )
        except requests.RequestException as err:
            raise AirtableError(f"Could not reach Airtable: {err}") from err

        if response.status_code == 401:
            raise AirtableError(
                "Airtable rejected the token. It may have been revoked, or it may be missing a scope."
            )
        if response.status_code == 403:
            raise AirtableError(
                "That token is not allowed to do this. It needs `data.records:write` to submit "
                "feedback and `schema.bases:read` to inspect the base, and access is granted per base."
            )
        if response.status_code == 404:
            raise AirtableError(
                "Airtable could not find that base or table. Check AIRTABLE_BASE_ID and "
                "AIRTABLE_TABLE with `manage.py airtable_schema`."
            )
        if response.status_code == 422:
            # Airtable's own message names the offending field, which is far more useful than anything
            # this layer could say -- so it is passed through rather than replaced.
            raise AirtableError(f"Airtable rejected the record: {_detail(response)}")
        if response.status_code == 429:
            raise AirtableError("Airtable is rate-limiting this base. Try again in a moment.")
        if response.status_code >= 400:
            raise AirtableError(f"Airtable returned {response.status_code}: {_detail(response)}")

        try:
            return response.json()
        except ValueError:
            return {}

    # --- schema (read-only) --------------------------------------------------

    def list_bases(self) -> list[dict]:
        return self._request("GET", f"{API_BASE}/meta/bases").get("bases") or []

    def base_schema(self) -> dict:
        return self._request("GET", f"{API_BASE}/meta/bases/{self.base_id}/tables")

    # --- writing -------------------------------------------------------------

    def create_record(self, fields: dict) -> str:
        """One record. Returns its id, which the attachment upload needs."""
        from urllib.parse import quote

        result = self._request(
            "POST",
            f"{API_BASE}/{self.base_id}/{quote(self.table, safe='')}",
            json={
                "fields": fields,
                # So a `Status` that is a single select accepts the string "New" and creates the option
                # if the base allows it, rather than 422-ing on a base whose choices differ.
                "typecast": True,
            },
        )
        record_id = result.get("id")
        if not record_id:
            raise AirtableError("Airtable created no record.")
        return record_id

    def upload_attachment(self, record_id: str, filename: str, content_type: str, data: bytes) -> None:
        """
        Attach one file to an existing record.

        Separate from `create_record` because Airtable's records API takes a URL for an attachment
        rather than bytes -- see the module docstring. Failing here leaves the record intact and its
        attachment missing, which is the right way round.
        """
        from urllib.parse import quote

        self._request(
            "POST",
            f"{UPLOAD_BASE}/{self.base_id}/{record_id}/{quote(FIELD_ATTACHMENTS, safe='')}/uploadAttachment",
            json={
                "contentType": content_type or "application/octet-stream",
                "file": base64.b64encode(data).decode("ascii"),
                "filename": filename or "attachment",
            },
        )


def _detail(response) -> str:
    """Airtable's own error text, or the status line when it sent none."""
    try:
        body = response.json()
    except ValueError:
        return response.text[:200]
    error = body.get("error")
    if isinstance(error, dict):
        return error.get("message") or error.get("type") or str(error)[:200]
    return str(error or body)[:200]
