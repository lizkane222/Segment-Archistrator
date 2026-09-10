"""
POST /api/feedback — one record into Airtable.

Open to any session, connected or not (`HasSession`). Feedback about the canvas has nothing to do with
whether a Segment workspace is attached, and the visitor most likely to hit a problem worth reporting is
the one who has not got that far.

The token never leaves the server. See `airtable.py` for why that is the whole reason this endpoint
exists rather than the form calling Airtable directly.
"""

import logging

from django.conf import settings
from rest_framework import status
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.auth_workspace.permissions import AllowAny, HasSession

from .airtable import AirtableClient, AirtableError, AirtableNotConfigured
from .serializers import MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, FeedbackSerializer

logger = logging.getLogger(__name__)


class FeedbackConfigView(APIView):
    """
    Whether the form is available at all.

    The UI asks before drawing a Submit button. An unconfigured Airtable is a supported state -- someone
    running this locally has no token -- and the honest response is to say the form is unavailable rather
    than to offer one whose submit fails with a 500.
    """

    permission_classes = [AllowAny]

    def get(self, request):
        return Response(
            {
                "available": bool(settings.AIRTABLE_API_KEY and settings.AIRTABLE_BASE_ID),
                "maxAttachments": MAX_ATTACHMENTS,
                "maxAttachmentBytes": MAX_ATTACHMENT_BYTES,
            }
        )


class FeedbackView(APIView):
    permission_classes = [HasSession]
    # Multipart so attachments can ride along with the fields in one request; JSON so a submission
    # without files needs no FormData on the client.
    parser_classes = [MultiPartParser, FormParser, JSONParser]

    def post(self, request):
        serializer = FeedbackSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)

        files = request.FILES.getlist("attachments")[:MAX_ATTACHMENTS]
        oversized = [f.name for f in files if f.size > MAX_ATTACHMENT_BYTES]
        if oversized:
            return Response(
                {
                    "error": {
                        "code": "attachment_too_large",
                        "message": (
                            f"{', '.join(oversized)} is over the "
                            f"{MAX_ATTACHMENT_BYTES // (1024 * 1024)}MB limit."
                        ),
                    }
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            client = AirtableClient.from_settings()
        except AirtableNotConfigured as err:
            # 503, not 500: nothing is broken, the feature is not configured on this deployment.
            return Response(
                {"error": {"code": "feedback_unavailable", "message": str(err)}},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        fields = serializer.to_fields(app_name=settings.AIRTABLE_APP_NAME)

        try:
            record_id = client.create_record(fields)
        except AirtableError as err:
            logger.warning("Airtable refused a feedback record: %s", err)
            return Response(
                {"error": {"code": "airtable_error", "message": str(err)}},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        # After the record, and each failure reported without losing the record. The description is the
        # part worth keeping; a screenshot that did not attach is a caveat, not a reason to discard a
        # report the user has already written.
        attached = 0
        failed = []
        for upload in files:
            try:
                client.upload_attachment(
                    record_id, upload.name, getattr(upload, "content_type", ""), upload.read()
                )
                attached += 1
            except AirtableError as err:
                logger.warning("Attachment %s failed for %s: %s", upload.name, record_id, err)
                failed.append(upload.name)

        logger.info("Feedback %s recorded with %d attachment(s)", record_id, attached)
        return Response(
            {
                "id": record_id,
                "title": fields["Problem Title"],
                "attached": attached,
                # Named, so the user can retry the one that failed rather than re-submitting everything.
                "attachmentsFailed": failed,
            },
            status=status.HTTP_201_CREATED,
        )
