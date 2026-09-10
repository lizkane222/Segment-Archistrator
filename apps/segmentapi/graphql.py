"""
A read-only client for the Segment app's own GraphQL gateway.

## Why this exists

The Public API needs a token someone has to go and create in Access Management, and on a
customer's workspace that is often a request that takes days. Anyone already logged in to
`app.segment.com` is holding a credential the app itself uses, and the ask was to accept that
too so a workspace can be read without waiting for a token to be minted.

So this is a second way in, offered beside the Public API token rather than instead of it and
with no preference expressed between them.

## What the credential is, stated plainly

`auth_token` is the **logged-in session** of whoever copied it. It is not a scoped read-only
token and cannot be made into one:

  - It carries the whole of that person's access, in every workspace they can reach -- not
    just the one being diagrammed, and not just reading.
  - It cannot be revoked on its own. Revoking it means ending that person's session.
  - It is a JWT with about a week's life (`addExpires` in the app's cookie middleware), so it
    keeps working long after the person who pasted it has stopped thinking about it.

This client is therefore deliberately narrow: `query` refuses anything but a query document
(see `_REFUSES_MUTATION`), so a bug or a bad caller here cannot turn a session credential into
a write against a customer's workspace. That is a guard against *this* code, not a security
boundary -- the gateway would happily accept a mutation with this token. The boundary is that
we never send one.

## Throttling

One request per second, process-wide, enforced in `_wait_turn`. This is somebody's live
session against Segment's own production gateway, so the polite ceiling was asked for
explicitly and is applied here rather than left to callers -- a limit each caller has to
remember is a limit that holds until the next caller.

Process-wide via a module lock, which is the right scope for a single-process dev server and
an honest under-approximation for anything multi-process: N workers would allow N per second.
Worth knowing before this runs behind gunicorn; the fix then is a shared limiter (Redis), not
a tighter local one.

## What was read to write this

`segmentio/app`, read-only, at `packages/gateway-api/src`:

  - `GatewayAPI.ts` mounts the gateway at `POST /graphql`; the browser reaches it at
    `/gateway-api/graphql` (`packages/app/client/lib/path-helpers/backend.ts`).
  - `middleware/auth.ts`'s `getAuthToken` prefers `Authorization: Bearer <token>` and only
    falls back to the cookie. That is why this sends a header: reading the cookie server-side
    additionally requires an `x-requested-with` header to satisfy the gateway's CSRF stand-in
    (`middleware/segment-cookies.ts`), and a bearer header avoids that entirely.
  - `allowlists.ts` gives the two app origins, which is where the region hosts below come from.
  - `graphql/schema.graphql` declares `RootQuery.workspaces: [Workspace!]` and a `Workspace`
    with `id`, `slug`, `name` and `region` -- exactly the four fields a session row needs.
"""

import logging
import re
import threading
import time

import requests
import truststore
from django.conf import settings

from .exceptions import (
    SegmentAuthError,
    SegmentError,
    SegmentRateLimited,
    SegmentUnavailable,
)

truststore.inject_into_ssl()

logger = logging.getLogger(__name__)

# The app origins the gateway itself allowlists, plus the path the browser uses.
GRAPHQL_HOSTS = {
    "us": "https://app.segment.com",
    "eu": "https://eu1.app.segment.com",
}
GRAPHQL_PATH = "/gateway-api/graphql"

# Generous on read: the gateway fans out to a dozen internal services, and the workspace
# query is the cheapest thing it does.
DEFAULT_TIMEOUT = (5, 30)

# One per second, as asked. Held as an interval rather than a rate so the arithmetic in
# `_wait_turn` is a comparison against a monotonic clock and not a bucket to refill.
MIN_INTERVAL_SECONDS = 1.0

# Anything that is not a query. `subscription` is in here for the same reason `mutation` is:
# it is not a read that finishes, and this client has no business opening one.
_REFUSES_MUTATION = re.compile(r"\b(mutation|subscription)\b", re.IGNORECASE)

# The whole of what this client asks for today. Named so the log line and the test can both
# refer to it, and short on purpose -- `workspaces` with four scalar fields is the smallest
# question that proves a credential works and says which workspace it belongs to.
WORKSPACES_QUERY = """
query SegmentBuilderWorkspaces {
  workspaces {
    id
    slug
    name
    region
  }
}
"""

_turn_lock = threading.Lock()
_last_request_at = 0.0


def _wait_turn() -> None:
    """
    Block until at least `MIN_INTERVAL_SECONDS` has passed since the last request.

    The sleep happens while the lock is *held*, which is the point: two threads arriving
    together must not both see a stale timestamp, both decide they may go, and both go. It
    makes concurrent callers queue rather than burst, which is what a one-per-second ceiling
    has to mean to be worth stating.

    `time.monotonic`, not `time.time`, so an NTP correction or a laptop waking from sleep
    cannot make the interval look negative and let a burst through.
    """
    global _last_request_at
    with _turn_lock:
        elapsed = time.monotonic() - _last_request_at
        if elapsed < MIN_INTERVAL_SECONDS:
            time.sleep(MIN_INTERVAL_SECONDS - elapsed)
        _last_request_at = time.monotonic()


class SegmentGraphQLClient:
    """
    Queries -- and only queries -- against one region's gateway, for one `auth_token`.

    Deliberately not a subclass of, or a drop-in for, `SegmentClient`. The two speak different
    protocols to different services with different credentials, and a shared base class would
    invite a caller to reach for a Public API method on a session credential and get a
    confusing 401 from somewhere else entirely.
    """

    def __init__(self, token: str, region: str = "us"):
        self._token = token
        self.region = region if region in GRAPHQL_HOSTS else "us"
        self.url = f"{GRAPHQL_HOSTS[self.region]}{GRAPHQL_PATH}"
        # No retry adapter, unlike SegmentClient. A retry multiplies requests against
        # somebody's live session, and the throttle above is the whole point -- so a failure
        # here is reported rather than quietly tried again.
        self._session = requests.Session()

    @classmethod
    def for_session(cls, workspace_session) -> "SegmentGraphQLClient":
        return cls(workspace_session.reveal_token(), region=workspace_session.region)

    @property
    def _headers(self) -> dict:
        return {
            # Bearer rather than a Cookie header: `getAuthToken` checks this first, and the
            # cookie route would also need the gateway's `x-requested-with` CSRF stand-in.
            "Authorization": f"Bearer {self._token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    def query(self, document: str, variables: dict | None = None, *, operation: str = "") -> dict:
        """
        Run one query and return its `data`.

        @raises ValueError          the document is not a query -- refused before any network
            call, so a mutation cannot leave this process even by mistake
        @raises SegmentAuthError    the token was rejected or has expired
        @raises SegmentError        the gateway answered with GraphQL errors
        """
        if _REFUSES_MUTATION.search(document):
            # Loud, and a ValueError rather than a SegmentError: this is a bug in the caller,
            # not a response from Segment, and it must never be caught by an `except
            # SegmentError` that was written to handle a flaky network.
            raise ValueError(
                "This client is read-only: it sends queries and never mutations. "
                "The credential behind it is somebody's login session."
            )

        _wait_turn()

        payload = {"query": document}
        if variables:
            payload["variables"] = variables

        try:
            response = self._session.post(
                # The operation name in the query string, exactly as the app does it, so these
                # requests are identifiable in Segment's own logs rather than anonymous.
                f"{self.url}?operation={operation or 'segment_builder'}",
                json=payload,
                headers=self._headers,
                timeout=DEFAULT_TIMEOUT,
            )
        except requests.RequestException as err:
            raise SegmentUnavailable(f"Could not reach Segment's GraphQL gateway: {err}") from err

        if response.status_code in (400, 401, 403):
            # 400 is in here with the two obvious ones because `auth.ts` throws `BadRequest`
            # for a token it cannot decode -- an expired or truncated paste arrives as a 400,
            # and reporting that as a server fault would send the user looking in the wrong
            # place entirely.
            raise SegmentAuthError(
                "Segment rejected that auth_token. It may have expired -- they last about a "
                "week -- or been truncated on the way out of the browser. Copy it again."
            )
        if response.status_code == 429:
            raise SegmentRateLimited("Segment's gateway is rate-limiting this session.")
        if response.status_code >= 500:
            raise SegmentUnavailable(
                f"Segment's GraphQL gateway returned {response.status_code}."
            )

        try:
            body = response.json()
        except ValueError as err:
            raise SegmentError("Segment's GraphQL gateway did not return JSON.") from err

        if body.get("errors"):
            messages = [
                str(entry.get("message", "")) for entry in body["errors"] if isinstance(entry, dict)
            ]
            joined = "; ".join(message for message in messages if message)
            # An unauthenticated GraphQL response is a 200 with an error in the body, so the
            # status check above does not catch it. Without this the user would be told the
            # workspace list was empty rather than that their token was refused.
            if re.search(r"unauthor|unauthenticat|forbidden|permission", joined, re.IGNORECASE):
                raise SegmentAuthError(
                    "That auth_token was accepted but is not allowed to read workspaces: "
                    f"{joined}"
                )
            raise SegmentError(joined or "Segment's GraphQL gateway returned an error.")

        return body.get("data") or {}

    # --- the one read this is used for today ---------------------------------

    def list_workspaces(self) -> list[dict]:
        """
        Every workspace this login can see, as `{id, slug, name, region}`.

        Plural, and that is a fact about the credential rather than a convenience: an
        `auth_token` is a person, and a person -- especially a Twilion -- is in many
        workspaces. Which one is being diagrammed is therefore a *choice*, and the caller has
        to make it. A client that quietly returned the first would connect a solutions
        engineer to whichever workspace happened to sort first out of two hundred.
        """
        data = self.query(WORKSPACES_QUERY, operation="segment_builder_workspaces")
        found = data.get("workspaces")
        if not isinstance(found, list):
            raise SegmentError("Segment's GraphQL gateway returned no workspace list.")

        workspaces = []
        for entry in found:
            if not isinstance(entry, dict) or not entry.get("id"):
                continue
            workspaces.append(
                {
                    "id": entry["id"],
                    "slug": entry.get("slug") or "",
                    "name": entry.get("name") or "",
                    "region": (entry.get("region") or "").lower(),
                }
            )
        if not workspaces:
            raise SegmentAuthError(
                "That auth_token works, but it can see no workspaces. Check you copied it "
                "from a browser that is logged in to the workspace you want to read."
            )
        return workspaces


# --- reading a workspace's graph ---------------------------------------------

"""
Why this is an *adapter* and not a second graph builder.

`apps/catalog/resources.py` already assembles the whole workspace -- nodes, edges, zones, warnings --
and every node goes through `schemas.normalize_*`, which is deliberately tolerant about shape (it reads
`metadata.slug` or `type`, `name` or `slug`, and so on). So the cheapest correct way to make a GraphQL
session useful is to hand that pipeline dicts of the shape it already expects, rather than to write a
parallel builder that would drift from it feature by feature.

That is what `GRAPH_QUERY` and the `as_*` functions below do: one query, then a reshape into the
Public API's own field names. Everything downstream -- normalisation, zoning, the canvas layout, the
walkthrough -- is unchanged and untested-against-GraphQL because it never sees GraphQL.

## One request, not thirty-six

The Public API needs a call per source to list what it is connected to (`_connections_for_source`
fans out across a thread pool). GraphQL does not: `Source.integrations` and `Source.warehouses` are
fields, so the connections come back with the sources in a single round trip. On a workspace with
thirty sources that is one request instead of thirty-one -- which matters here more than usual, because
this client is throttled to one request a second on purpose.

## Every field below was read from the schema, not guessed

A misspelled field fails the *whole* query, so each one was checked against
`packages/gateway-api/src/graphql/{sources,integrations,warehouses}/queries.graphql`:

    Workspace   id slug name region sources warehouses
    Source      id slug name enabled metadata integrations warehouses
    SourceMetadata  id name slug
    Integration id name enabled metadataId
    Warehouse   id name enabled

Deliberately narrow. `Source.writeKeys` is not requested -- a write key is a credential, this client
holds somebody's login session, and the canvas masks the key anyway. Nothing is requested that the
canvas does not draw.
"""

GRAPH_QUERY = """
query SegmentBuilderWorkspaceGraph($slug: Slug!) {
  workspace(slug: $slug) {
    id
    slug
    name
    region
    sources {
      id
      slug
      name
      enabled
      metadata {
        id
        name
        slug
      }
      integrations {
        id
        name
        enabled
        metadataId
      }
      warehouses {
        id
        name
        enabled
      }
    }
    warehouses {
      id
      name
      enabled
    }
  }
}
"""


def as_source(raw: dict) -> dict:
    """A GraphQL `Source` in the Public API's shape, for `schemas.normalize_source`."""
    metadata = raw.get("metadata") or {}
    return {
        "id": raw.get("id") or "",
        "slug": raw.get("slug") or raw.get("name") or "",
        "name": raw.get("name") or raw.get("slug") or "",
        "enabled": raw.get("enabled", True),
        # `normalize_source` reads the source type from `metadata.slug` first, which is exactly what
        # the GraphQL field is -- so this passes through rather than being translated.
        "metadata": {
            "id": metadata.get("id") or "",
            "name": metadata.get("name") or "",
            "slug": metadata.get("slug") or "",
        },
        # Absent on purpose, not forgotten: a write key is a credential and this client is holding
        # somebody's login session. `normalize_source` masks a missing key to None, which is the same
        # thing the canvas shows for a source whose key nobody has revealed.
        "settings": {},
    }


def as_destination(raw: dict) -> dict:
    """A GraphQL `Integration` in the Public API's destination shape."""
    return {
        "id": raw.get("id") or "",
        "name": raw.get("name") or "",
        # The Public API calls this `metadata.id`; GraphQL flattens it to `metadataId`. Nested back so
        # `normalize_destination` finds it where it looks.
        "metadata": {"id": raw.get("metadataId") or "", "slug": "", "name": raw.get("name") or ""},
        "enabled": raw.get("enabled", True),
        "settings": {},
    }


def as_warehouse(raw: dict) -> dict:
    """A GraphQL `Warehouse` in the Public API's shape."""
    return {
        "id": raw.get("id") or "",
        "name": raw.get("name") or "",
        "enabled": raw.get("enabled", True),
        # GraphQL's Warehouse carries no metadata slug, so the type is not knowable from this query.
        # Left empty rather than guessed: `normalize_warehouse` falls back to a generic warehouse,
        # which is honest, where a guess would label a Snowflake warehouse as BigQuery.
        "metadata": {"id": "", "slug": "", "name": ""},
        "settings": {},
    }


class GraphQLWorkspaceReader:
    """
    The workspace graph, read over GraphQL.

    Returns `{sources, destinations, warehouses, connections}` in Public API shapes, where
    `connections` maps a source id to the destination and warehouse ids it feeds. The caller assembles
    the graph from that with the code it already has.
    """

    def __init__(self, client: SegmentGraphQLClient, workspace_slug: str):
        self._client = client
        self._slug = workspace_slug

    def read(self) -> dict:
        data = self._client.query(
            GRAPH_QUERY,
            {"slug": self._slug},
            operation="segment_builder_workspace_graph",
        )
        workspace = data.get("workspace")
        if not workspace:
            raise SegmentAuthError(
                f"That session cannot see the workspace “{self._slug}”. It may have been "
                "disconnected, or the session may have expired."
            )

        sources: list[dict] = []
        destinations: dict[str, dict] = {}
        warehouses: dict[str, dict] = {}
        connections: dict[str, list[str]] = {}

        for raw in workspace.get("sources") or []:
            if not raw or not raw.get("id"):
                continue
            sources.append(as_source(raw))
            reached: list[str] = []

            for integration in raw.get("integrations") or []:
                if not integration or not integration.get("id"):
                    continue
                # De-duplicated by id: a destination connected to twenty sources appears under all
                # twenty, and the graph wants one node with twenty edges rather than twenty nodes.
                destinations.setdefault(integration["id"], as_destination(integration))
                reached.append(f"destination:{integration['id']}")

            for warehouse in raw.get("warehouses") or []:
                if not warehouse or not warehouse.get("id"):
                    continue
                warehouses.setdefault(warehouse["id"], as_warehouse(warehouse))
                reached.append(f"warehouse:{warehouse['id']}")

            connections[f"source:{raw['id']}"] = reached

        # Workspace-level warehouses too. A warehouse with no source connected to it is still part of
        # the architecture -- and is exactly the thing someone is looking for when they ask why nothing
        # is landing in it.
        for raw in workspace.get("warehouses") or []:
            if raw and raw.get("id"):
                warehouses.setdefault(raw["id"], as_warehouse(raw))

        return {
            "workspace": {
                "id": workspace.get("id") or "",
                "slug": workspace.get("slug") or self._slug,
                "name": workspace.get("name") or "",
                "region": (workspace.get("region") or "").lower(),
            },
            "sources": sources,
            "destinations": list(destinations.values()),
            "warehouses": list(warehouses.values()),
            "connections": connections,
        }
