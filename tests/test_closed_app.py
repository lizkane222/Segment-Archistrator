"""
The app is closed to anyone who has not signed in with an allowed Google Workspace domain.

Every other suite runs with `REQUIRE_ACCOUNT = False` (see config/settings/test.py), because it
predates the policy. These turn it on and ask the one question that matters: can a person who is
not a signed-in Twilion reach, save, or connect anything?
"""

import pytest
import responses as responses_lib
from rest_framework.test import APIClient

from apps.accounts.admission import admit
from apps.accounts.models import Account
from apps.auth_workspace.models import WorkspaceSession
from tests.conftest import GOOGLE_SUB, GOOGLE_TOKEN_URL, fake_id_token
from tests.test_oauth import CALLBACK, begin, query_of

pytestmark = pytest.mark.django_db


@pytest.fixture
def closed(settings):
    settings.REQUIRE_ACCOUNT = True
    settings.INVITATIONS_ENABLED = False
    settings.ALLOWED_EMAIL_DOMAINS = ["twilio.com"]
    return settings


def client_with(session):
    client = APIClient()
    client.cookies["sab_session"] = str(session.id)
    return client


@pytest.fixture
def twilion(db):
    return Account.objects.create(email="sol@twilio.com", google_sub="sub-sol")


# --- shut out ---------------------------------------------------------------

OPEN_BEFORE = [
    "/api/templates",
    "/api/meta/topology",
    "/api/catalog/sources",
    "/api/catalog/destinations",
    "/api/nuances?kind=source",
    "/api/diagrams",
    "/api/feedback/config",
]


@pytest.mark.parametrize("url", OPEN_BEFORE)
def test_nobody_without_a_session_reads_anything(closed, url):
    assert APIClient().get(url).status_code in (401, 403)


@pytest.mark.parametrize("url", OPEN_BEFORE)
def test_an_account_less_session_reads_nothing_either(closed, anon_session, url):
    assert client_with(anon_session).get(url).status_code in (401, 403)


def test_an_account_less_session_is_not_a_session(closed, anon_session):
    payload = client_with(anon_session).get("/api/session").json()
    assert payload["hasSession"] is False
    assert payload["auth"]["required"] is True


def test_nobody_can_mint_an_anonymous_scope(closed):
    response = APIClient().post("/api/session/anonymous")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "sign_in_required"
    assert WorkspaceSession.objects.count() == 0


def test_nobody_can_save_a_diagram(closed, anon_session):
    response = client_with(anon_session).post(
        "/api/diagrams", {"name": "x", "graph": {"nodes": [], "edges": []}}, format="json"
    )
    assert response.status_code in (401, 403)


def test_a_token_cannot_be_pasted_without_signing_in(closed, workspace_ok):
    response = APIClient().post("/api/session", {"token": "sgp_x", "region": "us"}, format="json")
    assert response.status_code == 401
    assert WorkspaceSession.objects.count() == 0


def test_the_health_check_stays_open(closed):
    assert APIClient().get("/api/health").status_code == 200


def test_a_signed_in_twilion_gets_in(closed, twilion):
    session = WorkspaceSession.start_for_account(twilion)
    client = client_with(session)
    assert client.get("/api/templates").status_code == 200
    assert client.get("/api/session").json()["hasSession"] is True


def test_logging_out_drops_the_session_entirely(closed, twilion):
    session = WorkspaceSession.start_for_account(twilion)
    client = client_with(session)
    response = client.post("/api/auth/logout")
    assert response.status_code == 200
    assert response.json()["hasSession"] is False
    assert not WorkspaceSession.objects.exists()


# --- who may sign in --------------------------------------------------------


def test_a_twilio_workspace_account_is_admitted(closed):
    account, refusal = admit(
        email="Sol@Twilio.com", google_sub="s1", email_verified=True, hosted_domain="twilio.com"
    )
    assert refusal is None
    assert account.email == "sol@twilio.com"


@pytest.mark.parametrize(
    "email,hd",
    [
        ("outsider@gmail.com", ""),
        ("outsider@evil.com", "evil.com"),
        ("sol@twilio.com", ""),  # a consumer Google account that merely verified a twilio address
        ("sol@twilio.com", "evil.com"),
        ("sol@mail.twilio.com", "twilio.com"),
        ("sol@twilio.com.evil.com", "twilio.com"),
        ("sol@twilio.com", "twilio.com.evil.com"),
        ("sol@twilio.co", "twilio.co"),
    ],
)
def test_everyone_else_is_refused(closed, email, hd):
    account, refusal = admit(email=email, google_sub="s2", email_verified=True, hosted_domain=hd)
    assert account is None
    assert refusal
    assert Account.objects.count() == 0


def test_an_invitation_is_not_a_way_round_the_domain(closed, twilion):
    from apps.accounts.admission import invite

    invite(email="outsider@gmail.com", invited_by=twilion)
    account, refusal = admit(
        email="outsider@gmail.com", google_sub="s3", email_verified=True, hosted_domain=""
    )
    assert account is None


def test_an_existing_account_off_the_domain_is_locked_out(closed):
    Account.objects.create(email="old@gmail.com", google_sub="s4")
    account, refusal = admit(
        email="old@gmail.com", google_sub="s4", email_verified=True, hosted_domain=""
    )
    assert account is None


def test_an_unverified_twilio_address_is_refused(closed):
    account, _ = admit(
        email="sol@twilio.com", google_sub="s5", email_verified=False, hosted_domain="twilio.com"
    )
    assert account is None


def test_inviting_is_switched_off(closed, twilion):
    session = WorkspaceSession.start_for_account(twilion)
    response = client_with(session).post("/api/invitations", {"email": "x@gmail.com"}, format="json")
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "invitations_disabled"


def test_the_whole_oauth_flow_refuses_a_non_workspace_account(closed, mock_segment, google_configured):
    google_configured.ALLOWED_EMAIL_DOMAINS = ["twilio.com"]
    mock_segment.add(
        responses_lib.POST,
        GOOGLE_TOKEN_URL,
        json={"id_token": fake_id_token(email="sol@twilio.com", sub="s6")},  # no `hd`
        status=200,
    )
    client = APIClient()
    state = begin(client)
    response = client.get(CALLBACK, {"state": state, "code": "c"})
    assert "auth_error" in query_of(response)
    assert "sab_session" not in response.cookies
    assert Account.objects.count() == 0


def test_the_whole_oauth_flow_admits_a_workspace_account(closed, mock_segment, google_configured):
    google_configured.ALLOWED_EMAIL_DOMAINS = ["twilio.com"]
    mock_segment.add(
        responses_lib.POST,
        GOOGLE_TOKEN_URL,
        json={"id_token": fake_id_token(email="sol@twilio.com", sub="s7", hd="twilio.com")},
        status=200,
    )
    client = APIClient()
    state = begin(client)
    response = client.get(CALLBACK, {"state": state, "code": "c"})
    assert query_of(response)["signed_in"] == ["sol@twilio.com"]
    assert "sab_session" in response.cookies


def test_the_consent_url_hints_the_company_domain(closed, google_configured, client):
    google_configured.ALLOWED_EMAIL_DOMAINS = ["twilio.com"]
    response = client.get("/api/auth/google/start")
    assert query_of(response)["hd"] == ["twilio.com"]


def test_production_refuses_to_boot_with_no_allowed_domain():
    import importlib

    import pytest as _pytest
    from django.core.exceptions import ImproperlyConfigured

    import config.settings.prod as prod

    with _pytest.MonkeyPatch.context() as mp:
        mp.setenv("ALLOWED_EMAIL_DOMAINS", "")
        mp.setenv("SEGMENT_TOKEN_ENCRYPTION_KEYS", "cSHRy2W9U0YvrRT7yBn6zeqXwuDIsRV8sf3IY8Xnf7A=")
        import config.settings.base as base

        importlib.reload(base)
        with _pytest.raises(ImproperlyConfigured):
            importlib.reload(prod)
    importlib.reload(base)
