"""
HTTP client for the Segment Public API and Profile API.

Two things this deliberately does differently from the reference script in
`../DestinationFunctionTemplate/.../deployDestinationFunction.js`:

1. That script retries on **any** status >= 400 with 12 attempts of exponential
   backoff. A rejected token (401) would therefore spin for roughly 2.3 hours
   before surfacing. Here retries are confined to 429 and 5xx; 4xx fails at once.
2. Retries honour `Retry-After`, which the Public API sends on token-scoped 429s.

Pagination is always sent, even where the docs call it optional -- several
endpoints (`/catalog/destinations`, the `connected-*` pair) return 422 without it.
"""

import base64
import logging
from typing import Any, Iterator
from urllib.parse import urljoin

import requests
import truststore
from django.conf import settings
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

# Verify against the OS trust store instead of certifi's bundled roots. On a
# machine behind a TLS-inspecting proxy (Zscaler, corporate MITM, etc.) the OS
# store has the proxy's root CA -- installed by MDM -- but certifi never will,
# since that CA isn't in Mozilla's public root program. Without this, every
# outbound call here fails with CERTIFICATE_VERIFY_FAILED even though the
# token and endpoint are both fine. Safe on unproxied machines too: it just
# verifies against the same roots the OS (and curl) already trusts.
truststore.inject_into_ssl()

from . import endpoints as ep
from .exceptions import (
    SegmentAuthError,
    SegmentError,
    SegmentFeatureUnavailable,
    SegmentNotFound,
    SegmentRateLimited,
    SegmentUnavailable,
    SegmentValidationError,
)

logger = logging.getLogger(__name__)

DEFAULT_PAGE_SIZE = 200  # API default; max is 1000.
DEFAULT_TIMEOUT = (5, 30)  # (connect, read)

# A hard ceiling on pages walked per call, so a misbehaving cursor cannot spin
# forever. 200 pages x 200 items is far beyond any real workspace.
MAX_PAGES = 200


def _build_session() -> requests.Session:
    retry = Retry(
        total=5,
        # Only transient failures. Notably absent: 400, 401, 403, 404, 422.
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=frozenset(["GET", "HEAD"]),
        backoff_factor=1,
        respect_retry_after_header=True,
        raise_on_status=False,  # we map statuses ourselves
    )
    session = requests.Session()
    adapter = HTTPAdapter(max_retries=retry, pool_maxsize=10)
    session.mount("https://", adapter)
    return session


class SegmentClient:
    """
    Public API client bound to one token and region.

    Construct via `for_session(workspace_session)` in views, or `for_token()`
    during token validation, when no session row exists yet.
    """

    def __init__(self, token: str, region: str = "us"):
        self._token = token
        self.region = region if region in settings.SEGMENT_API_BASE_URLS else "us"
        self.base_url = settings.SEGMENT_API_BASE_URLS[self.region]
        self._http = _build_session()

    # --- constructors -------------------------------------------------------

    @classmethod
    def for_token(cls, token: str, region: str = "us") -> "SegmentClient":
        return cls(token=token, region=region)

    @classmethod
    def for_session(cls, workspace_session) -> "SegmentClient":
        return cls(
            token=workspace_session.reveal_token(),
            region=workspace_session.region,
        )

    # --- core request -------------------------------------------------------

    def request(
        self,
        endpoint: ep.Endpoint,
        *,
        path_params: dict | None = None,
        params: dict | None = None,
        method: str = "GET",
    ) -> dict[str, Any]:
        path = endpoint.format(**(path_params or {}))
        url = urljoin(self.base_url, path) if path != "/" else self.base_url + "/"
        headers = {
            "Authorization": f"Bearer {self._token}",
            "Accept": endpoint.accept,
        }

        try:
            response = self._http.request(
                method,
                url,
                headers=headers,
                params=params or None,
                timeout=DEFAULT_TIMEOUT,
            )
        except requests.Timeout as exc:
            raise SegmentUnavailable("The Segment API timed out.") from exc
        except requests.RequestException as exc:
            raise SegmentUnavailable(f"Could not reach the Segment API: {exc}") from exc

        if response.status_code >= 400:
            raise self._map_error(response, endpoint)

        if not response.content:
            return {}
        try:
            return response.json()
        except ValueError as exc:
            # A non-JSON body from a 2xx means something upstream of the API
            # answered (proxy, error page). Surface it as unavailable rather than
            # letting a JSONDecodeError escape as a 500.
            raise SegmentUnavailable(
                "The Segment API returned a non-JSON response."
            ) from exc

    def _map_error(self, response: requests.Response, endpoint: ep.Endpoint) -> SegmentError:
        status = response.status_code
        try:
            body = response.json()
        except ValueError:
            body = {}
        message = (
            (body.get("errors") or [{}])[0].get("message")
            if isinstance(body.get("errors"), list)
            else None
        ) or body.get("message")

        if status in (401, 403):
            return SegmentAuthError(
                message or "The Segment Public API token was rejected.",
                upstream_status=status,
            )

        if status == 429:
            # Two distinct limits. The per-endpoint one carries
            # data.remainingPoints; the per-token one carries Retry-After.
            data = body.get("data") or {}
            scope = "endpoint" if "remainingPoints" in data else "token"
            retry_after = response.headers.get("Retry-After")
            try:
                retry_after = int(retry_after) if retry_after else None
            except (TypeError, ValueError):
                retry_after = None
            hint = ""
            if endpoint.rate_limit_per_min:
                hint = f" This endpoint allows {endpoint.rate_limit_per_min} requests/minute."
            return SegmentRateLimited(
                (message or "Segment rate limit reached.") + hint,
                retry_after=retry_after,
                scope=scope,
                upstream_status=status,
            )

        if status == 404:
            # For feature-gated endpoints a 404 usually means the workspace does
            # not have the feature rather than that the path is wrong. The UI
            # should degrade gracefully instead of showing an error.
            if endpoint.requires_feature:
                return SegmentFeatureUnavailable(
                    message
                    or (
                        f"The '{endpoint.requires_feature}' feature is not enabled "
                        "for this workspace."
                    ),
                    upstream_status=status,
                )
            return SegmentNotFound(message, upstream_status=status)

        if status == 422:
            return SegmentValidationError(message, upstream_status=status)

        if status >= 500:
            return SegmentUnavailable(message, upstream_status=status)

        return SegmentError(message, upstream_status=status)

    # --- pagination ---------------------------------------------------------

    def paginate(
        self,
        endpoint: ep.Endpoint,
        *,
        item_key: str,
        path_params: dict | None = None,
        params: dict | None = None,
        page_size: int = DEFAULT_PAGE_SIZE,
        max_items: int | None = None,
    ) -> Iterator[dict]:
        """
        Walk a cursor-paginated list endpoint, yielding items.

        Response shape is `{"data": {<item_key>: [...], "pagination": {...}}}`.
        An absent or empty `pagination.next` ends the walk.
        """
        cursor: str | None = None
        seen = 0
        pages = 0
        seen_cursors: set[str] = set()

        while True:
            query = dict(params or {})
            query["pagination.count"] = page_size
            if cursor:
                query["pagination.cursor"] = cursor

            payload = self.request(endpoint, path_params=path_params, params=query)
            data = payload.get("data") or {}
            items = data.get(item_key) or []

            for item in items:
                yield item
                seen += 1
                if max_items is not None and seen >= max_items:
                    return

            pages += 1
            cursor = (data.get("pagination") or {}).get("next")
            if not cursor:
                return
            if cursor in seen_cursors:
                logger.warning(
                    "Repeated pagination cursor on %s; stopping to avoid a loop.",
                    endpoint.path,
                )
                return
            seen_cursors.add(cursor)
            if pages >= MAX_PAGES:
                logger.warning(
                    "Hit MAX_PAGES (%s) on %s after %s items; truncating.",
                    MAX_PAGES,
                    endpoint.path,
                    seen,
                )
                return

    def list_all(self, endpoint: ep.Endpoint, *, item_key: str, **kwargs) -> list[dict]:
        return list(self.paginate(endpoint, item_key=item_key, **kwargs))

    # --- identity -----------------------------------------------------------

    def get_workspace(self) -> dict:
        """
        Validate the token and derive the workspace.

        `GET /` -> {"data": {"workspace": {"id", "name", "slug"}}}
        Raises SegmentAuthError when the token is rejected.
        """
        payload = self.request(ep.GET_WORKSPACE)
        workspace = (payload.get("data") or {}).get("workspace")
        if not workspace or not workspace.get("id"):
            raise SegmentAuthError(
                "Segment accepted the request but returned no workspace. "
                "The token may lack the required scopes."
            )
        return workspace

    # --- Connections --------------------------------------------------------

    def list_sources(self, **kw) -> list[dict]:
        return self.list_all(ep.LIST_SOURCES, item_key="sources", **kw)

    def list_destinations(self, **kw) -> list[dict]:
        return self.list_all(ep.LIST_DESTINATIONS, item_key="destinations", **kw)

    def list_warehouses(self, **kw) -> list[dict]:
        return self.list_all(ep.LIST_WAREHOUSES, item_key="warehouses", **kw)

    def list_connected_destinations(self, source_id: str) -> list[dict]:
        return self.list_all(
            ep.LIST_SOURCE_CONNECTED_DESTINATIONS,
            item_key="destinations",
            path_params={"source_id": source_id},
        )

    def list_connected_warehouses(self, source_id: str) -> list[dict]:
        return self.list_all(
            ep.LIST_SOURCE_CONNECTED_WAREHOUSES,
            item_key="warehouses",
            path_params={"source_id": source_id},
        )

    def list_destination_filters(self, destination_id: str) -> list[dict]:
        return self.list_all(
            ep.LIST_DESTINATION_FILTERS,
            item_key="filters",
            path_params={"destination_id": destination_id},
        )

    def list_functions(self, resource_type: str) -> list[dict]:
        """`resourceType` is required by the API. See ep.FUNCTION_RESOURCE_TYPES."""
        if resource_type not in ep.FUNCTION_RESOURCE_TYPES:
            raise ValueError(
                f"resource_type must be one of {ep.FUNCTION_RESOURCE_TYPES}, "
                f"got {resource_type!r}"
            )
        return self.list_all(
            ep.LIST_FUNCTIONS,
            item_key="functions",
            params={"resourceType": resource_type},
        )

    def list_reverse_etl_models(self) -> list[dict]:
        return self.list_all(ep.LIST_REVERSE_ETL_MODELS, item_key="models")

    # --- Catalog ------------------------------------------------------------

    def catalog_sources(self) -> list[dict]:
        return self.list_all(ep.CATALOG_SOURCES, item_key="sourcesCatalog")

    def catalog_destinations(self) -> list[dict]:
        return self.list_all(ep.CATALOG_DESTINATIONS, item_key="destinationsCatalog")

    def catalog_warehouses(self) -> list[dict]:
        return self.list_all(ep.CATALOG_WAREHOUSES, item_key="warehousesCatalog")

    # --- Unify / Engage -----------------------------------------------------

    def list_spaces(self) -> list[dict]:
        return self.list_all(ep.LIST_SPACES, item_key="spaces")

    def list_audiences(self, space_id: str) -> list[dict]:
        return self.list_all(
            ep.LIST_AUDIENCES,
            item_key="audiences",
            path_params={"space_id": space_id},
        )

    def list_computed_traits(self, space_id: str) -> list[dict]:
        return self.list_all(
            ep.LIST_COMPUTED_TRAITS,
            item_key="computedTraits",
            path_params={"space_id": space_id},
        )

    def list_space_events(self, space_id: str, **kw) -> list[dict]:
        return self.list_all(
            ep.LIST_SPACE_EVENTS,
            item_key="events",
            path_params={"space_id": space_id},
            **kw,
        )

    def list_space_event_properties(
        self, space_id: str, event_name: str, *, include_samples: bool = True,
        samples_count: int = 3,
    ) -> list[dict]:
        """
        Properties of one event, optionally with sample values.

        `includeSampleValues` avoids an N+1 of sample-value calls -- which matters
        a great deal here, because this surface allows only 25 requests/minute.
        """
        params: dict[str, Any] = {}
        if include_samples:
            params["includeSampleValues"] = "true"
            params["samplesCount"] = samples_count
        return self.list_all(
            ep.LIST_SPACE_EVENT_PROPERTIES,
            item_key="properties",
            path_params={"space_id": space_id, "event_name": event_name},
            params=params,
        )

    def list_space_traits(
        self, space_id: str, *, collection: str = "users",
        include_samples: bool = True, samples_count: int = 3,
    ) -> list[dict]:
        params: dict[str, Any] = {"collection": collection}
        if include_samples:
            params["includeSampleValues"] = "true"
            params["samplesCount"] = samples_count
        return self.list_all(
            ep.LIST_SPACE_TRAITS,
            item_key="traits",
            path_params={"space_id": space_id},
            params=params,
        )

    # --- Profile API --------------------------------------------------------
    # Different host AND different auth scheme: Basic, with the token as the
    # username and an empty password -- hence the trailing colon before base64.
    # It also sends no CORS headers, which is an independent reason every call
    # has to be brokered here rather than from the browser.

    def _profile_headers(self) -> dict:
        encoded = base64.b64encode(f"{self._token}:".encode()).decode()
        return {"Authorization": f"Basic {encoded}", "Accept": "application/json"}

    def profile_request(self, space_id: str, path: str, params: dict | None = None) -> dict:
        url = f"{settings.SEGMENT_PROFILE_API_BASE}/spaces/{space_id}{path}"
        try:
            response = self._http.get(
                url,
                headers=self._profile_headers(),
                params=params or None,
                timeout=DEFAULT_TIMEOUT,
            )
        except requests.Timeout as exc:
            raise SegmentUnavailable("The Segment Profile API timed out.") from exc
        except requests.RequestException as exc:
            raise SegmentUnavailable(f"Could not reach the Profile API: {exc}") from exc

        if response.status_code >= 400:
            raise self._map_error(response, ep.GET_WORKSPACE)
        return response.json() if response.content else {}
