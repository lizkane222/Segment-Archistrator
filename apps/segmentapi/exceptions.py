"""
Normalized Segment API errors, plus the DRF handler that renders them.

The client layer raises exactly these; views never see a raw requests.Response.
That keeps error shape decisions in one place and stops HTTP details from
leaking into the frontend contract.
"""

import logging

from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_exception_handler

logger = logging.getLogger(__name__)


class SegmentError(Exception):
    """Base for every normalized Segment API failure."""

    status_code = status.HTTP_502_BAD_GATEWAY
    code = "segment_error"
    default_detail = "The Segment API request failed."

    def __init__(self, detail=None, *, upstream_status=None, upstream_body=None):
        self.detail = detail or self.default_detail
        self.upstream_status = upstream_status
        self.upstream_body = upstream_body
        super().__init__(self.detail)


class SegmentAuthError(SegmentError):
    """The token was rejected (401/403). Never retried."""

    status_code = status.HTTP_401_UNAUTHORIZED
    code = "segment_unauthorized"
    default_detail = "The Segment Public API token was rejected."


class SegmentNotFound(SegmentError):
    status_code = status.HTTP_404_NOT_FOUND
    code = "segment_not_found"
    default_detail = "The requested Segment resource does not exist."


class SegmentValidationError(SegmentError):
    """422 -- usually a missing required pagination param."""

    status_code = status.HTTP_400_BAD_REQUEST
    code = "segment_validation_failed"
    default_detail = "Segment rejected the request as invalid."


class SegmentRateLimited(SegmentError):
    status_code = status.HTTP_429_TOO_MANY_REQUESTS
    code = "segment_rate_limited"
    default_detail = "Segment rate limit reached. Try again shortly."

    def __init__(self, detail=None, *, retry_after=None, scope=None, **kwargs):
        super().__init__(detail, **kwargs)
        self.retry_after = retry_after
        # "endpoint" (body carries data.remainingPoints) vs "token" (carries
        # Retry-After). Worth surfacing: the two are hit for different reasons
        # and the user-facing advice differs.
        self.scope = scope


class SegmentUnavailable(SegmentError):
    status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    code = "segment_unavailable"
    default_detail = "Segment is unavailable or timed out."


class SegmentFeatureUnavailable(SegmentError):
    """
    The workspace lacks the feature (e.g. no Unify spaces, Alpha API not enabled).

    Distinct from NotFound because the UI should say "not enabled for this
    workspace" rather than "missing", and should degrade rather than error.
    """

    status_code = status.HTTP_409_CONFLICT
    code = "segment_feature_unavailable"
    default_detail = "This Segment feature is not enabled for the workspace."


def segment_exception_handler(exc, context):
    """DRF exception handler that renders SegmentError with a stable envelope."""
    if isinstance(exc, SegmentError):
        logger.warning(
            "Segment API error: %s (%s) upstream=%s",
            exc.code,
            exc.detail,
            exc.upstream_status,
        )
        body = {"error": {"code": exc.code, "message": str(exc.detail)}}
        headers = {}
        if isinstance(exc, SegmentRateLimited):
            if exc.scope:
                body["error"]["scope"] = exc.scope
            if exc.retry_after:
                body["error"]["retryAfter"] = exc.retry_after
                headers["Retry-After"] = str(exc.retry_after)
        return Response(body, status=exc.status_code, headers=headers)

    response = drf_exception_handler(exc, context)
    if response is not None and isinstance(response.data, dict):
        # Reshape DRF's own errors into the same {"error": {...}} envelope so the
        # frontend has exactly one error contract to handle.
        if "error" not in response.data:
            detail = response.data.get("detail")
            response.data = {
                "error": {
                    # The detail's own code first: DRF lets a permission class set
                    # one per instance, which is how two different refusals sharing
                    # a 403 stay distinguishable to the SPA. Falls back to the
                    # exception class's default_code, which is all most errors have.
                    "code": getattr(detail, "code", None)
                    or getattr(exc, "default_code", "request_failed"),
                    "message": str(detail) if detail else "Request failed.",
                    **({"fields": response.data} if detail is None else {}),
                }
            }
    return response
