"""
The Google sign-in round trip.

Two things get the most attention here, because they are what stands between this
endpoint and anyone who can craft a URL: the `state` row is single-use, and a callback
that cannot present a good one must be refused *before* anything is sent to Google.
Several tests assert that no upstream call was made for exactly that reason.

Google's token endpoint is stubbed through `mock_segment`, which intercepts all
outbound HTTP -- so a path that reaches the network unexpectedly fails rather than
silently calling out.
"""

import time
from urllib.parse import parse_qs, urlparse

import pytest
import responses as responses_lib
from rest_framework.test import APIClient

from apps.accounts.admission import invite
from apps.accounts.models import Account, OAuthLogin
from apps.auth_workspace.models import WorkspaceSession
from apps.diagrams.models import Diagram
from tests.conftest import GOOGLE_SUB, GOOGLE_TOKEN_URL, fake_id_token

pytestmark = pytest.mark.django_db

START = "/api/auth/google/start"
CALLBACK = "/api/auth/google/callback"


def query_of(response):
    return parse_qs(urlparse(response["Location"]).query)


def begin(client) -> str:
    """Run the start leg and return the state it minted."""
    assert client.get(START).status_code == 302
    return OAuthLogin.objects.get().state


# --- Starting ---------------------------------------------------------------


def test_start_redirects_to_google_with_the_expected_parameters(client, google_configured):
    response = client.get(START)
    assert response.status_code == 302

    location = urlparse(response["Location"])
    assert location.netloc == "accounts.google.com"

    query = query_of(response)
    assert query["client_id"] == ["123456.apps.googleusercontent.com"]
    assert query["response_type"] == ["code"]
    assert query["scope"] == ["openid email profile"]
    # No refresh token: this app never acts at Google on anyone's behalf, so there is
    # nothing to store, rotate or revoke.
    assert query["access_type"] == ["online"]
    assert query["prompt"] == ["select_account"]
    assert query["code_challenge_method"] == ["S256"]
    assert query["code_challenge"][0]
    assert query["state"] == [OAuthLogin.objects.get().state]


def test_start_says_so_when_google_is_not_configured(client, db):
    """
    Unconfigured is a supported state. Bouncing someone to a Google error page about an
    empty client id would not be.
    """
    response = client.get(START)
    assert response.status_code == 302
    assert query_of(response)["auth_error"]
    assert OAuthLogin.objects.count() == 0


def test_start_remembers_the_session_that_began_the_flow(anon_client, anon_session, google_configured):
    anon_client.get(START)
    assert OAuthLogin.objects.get().session_id == anon_session.id


def test_the_pkce_verifier_is_kept_server_side(client, google_configured):
    client.get(START)
    login = OAuthLogin.objects.get()
    assert login.code_verifier
    # The challenge travels; the verifier must not.
    assert login.code_verifier not in client.get(START)["Location"]


# --- Refusing a callback ----------------------------------------------------


def test_a_forged_state_is_refused_without_calling_google(client, google_ok):
    response = client.get(CALLBACK, {"state": "invented", "code": "whatever"})
    assert response.status_code == 302
    assert query_of(response)["auth_error"]
    # The important half: nothing was sent upstream.
    assert not google_ok.calls
    assert Account.objects.count() == 0


def test_a_replayed_state_is_refused_and_google_is_called_only_once(client, google_ok):
    state = begin(client)

    first = client.get(CALLBACK, {"state": state, "code": "code-1"})
    assert query_of(first).get("signed_in")

    second = client.get(CALLBACK, {"state": state, "code": "code-1"})
    assert query_of(second)["auth_error"]

    # Single-use is enforced by deleting the row, so the second attempt never reaches
    # the network.
    assert len(google_ok.calls) == 1
    assert Account.objects.count() == 1


def test_an_expired_state_is_refused(client, google_ok):
    from datetime import timedelta

    from django.utils import timezone

    state = begin(client)
    OAuthLogin.objects.filter(state=state).update(
        created_at=timezone.now() - timedelta(minutes=OAuthLogin.EXPIRY_MINUTES + 1)
    )

    response = client.get(CALLBACK, {"state": state, "code": "code-1"})
    assert query_of(response)["auth_error"]
    assert not google_ok.calls


def test_a_callback_with_no_code_is_refused(client, google_ok):
    state = begin(client)
    response = client.get(CALLBACK, {"state": state})
    assert query_of(response)["auth_error"]
    assert not google_ok.calls


def test_a_cancelled_consent_screen_is_not_an_error_page(client, google_ok):
    response = client.get(CALLBACK, {"error": "access_denied"})
    assert response.status_code == 302
    assert "cancelled" in query_of(response)["auth_error"][0].lower()
    assert not google_ok.calls


# --- Refusing a token -------------------------------------------------------


@pytest.mark.parametrize(
    "overrides,expected",
    [
        ({"aud": "someone-elses-client-id"}, "different application"),
        ({"iss": "evil.example.com"}, "not issued by Google"),
        ({"exp": int(time.time()) - 10}, "expired"),
        ({"email_verified": False}, "verified"),
    ],
)
def test_a_bad_claim_refuses_the_sign_in(client, mock_segment, google_configured, overrides, expected):
    mock_segment.add(
        responses_lib.POST,
        GOOGLE_TOKEN_URL,
        json={"id_token": fake_id_token(**overrides)},
        status=200,
    )
    state = begin(client)
    response = client.get(CALLBACK, {"state": state, "code": "code-1"})

    assert expected.lower() in query_of(response)["auth_error"][0].lower()
    assert Account.objects.count() == 0


def test_google_rejecting_the_exchange_never_echoes_the_client_secret(
    client, mock_segment, google_configured, caplog
):
    """
    Google echoes request parameters on some errors, and one of them is the client
    secret. Neither the redirect nor the log may carry it.
    """
    mock_segment.add(
        responses_lib.POST,
        GOOGLE_TOKEN_URL,
        json={"error": "invalid_grant", "client_secret": "test-client-secret"},
        status=400,
    )
    state = begin(client)
    response = client.get(CALLBACK, {"state": state, "code": "code-1"})

    assert query_of(response)["auth_error"]
    assert "test-client-secret" not in response["Location"]
    assert "test-client-secret" not in caplog.text
    assert Account.objects.count() == 0


def test_a_stranger_is_refused_by_the_admission_policy(client, mock_segment, google_configured):
    google_configured.ALLOWED_EMAIL_DOMAINS = ["example.com"]
    mock_segment.add(
        responses_lib.POST,
        GOOGLE_TOKEN_URL,
        json={"id_token": fake_id_token(email="outsider@elsewhere.com", sub="other-sub")},
        status=200,
    )
    state = begin(client)
    response = client.get(CALLBACK, {"state": state, "code": "code-1"})

    assert "invite you" in query_of(response)["auth_error"][0]
    assert Account.objects.count() == 0


def test_an_invited_stranger_gets_through_the_same_flow(client, mock_segment, google_configured, account):
    google_configured.ALLOWED_EMAIL_DOMAINS = []
    invite(email="outsider@elsewhere.com", invited_by=account)
    mock_segment.add(
        responses_lib.POST,
        GOOGLE_TOKEN_URL,
        json={"id_token": fake_id_token(email="outsider@elsewhere.com", sub="other-sub")},
        status=200,
    )
    state = begin(client)
    response = client.get(CALLBACK, {"state": state, "code": "code-1"})

    assert query_of(response).get("signed_in") == ["outsider@elsewhere.com"]
    assert Account.objects.filter(email="outsider@elsewhere.com").exists()


# --- Succeeding -------------------------------------------------------------


def test_a_successful_sign_in_sets_the_cookie_and_links_the_account(client, google_ok):
    state = begin(client)
    response = client.get(CALLBACK, {"state": state, "code": "code-1"})

    assert response.status_code == 302
    assert query_of(response)["signed_in"] == ["liz@example.com"]

    account = Account.objects.get()
    assert account.google_sub == GOOGLE_SUB
    assert account.name == "Liz Kane"
    assert account.last_login_at is not None

    cookie = response.cookies["sab_session"]
    assert cookie["httponly"] and cookie["samesite"] == "Lax"
    session = WorkspaceSession.objects.get(pk=cookie.value)
    assert session.account == account
    # Every session has somewhere to save, signed in or not.
    assert session.anon_scope


def test_the_id_tokens_signature_is_never_checked(client, google_ok):
    """
    Pins the design decision in apps/accounts/google.py: the token is read out of our
    own authenticated HTTPS POST, so TLS establishes provenance and the signature adds
    nothing. `fake_id_token` signs with the string "not-a-real-signature".
    """
    state = begin(client)
    assert query_of(client.get(CALLBACK, {"state": state, "code": "code-1"})).get("signed_in")


def test_signing_in_claims_the_diagrams_drawn_first(anon_client, anon_session, google_ok):
    """
    The headline of this whole change: work drawn before signing in stops depending on
    a cookie.
    """
    drawn = Diagram.objects.create(
        anon_scope=anon_session.anon_scope, name="Drawn first", graph={"nodes": []}
    )
    elsewhere = Diagram.objects.create(
        anon_scope="anon:somebodyelse", name="Not mine", graph={"nodes": []}
    )

    state = begin(anon_client)
    response = anon_client.get(CALLBACK, {"state": state, "code": "code-1"})
    assert query_of(response)["claimed"] == ["1"]

    account = Account.objects.get()
    drawn.refresh_from_db()
    assert drawn.owner == account
    # Cleared, so a resurfacing cookie cannot still reach something an account owns.
    assert drawn.anon_scope == ""

    elsewhere.refresh_from_db()
    assert elsewhere.owner_id is None


def test_the_claimed_diagram_is_reachable_after_the_cookie_is_thrown_away(
    anon_client, anon_session, google_ok
):
    """The actual failure this feature exists to fix, end to end."""
    Diagram.objects.create(
        anon_scope=anon_session.anon_scope, name="Survivor", graph={"nodes": []}
    )
    state = begin(anon_client)
    signed_in = anon_client.get(CALLBACK, {"state": state, "code": "code-1"})
    cookie = signed_in.cookies["sab_session"].value

    # A brand-new browser presenting only the post-sign-in cookie.
    fresh = APIClient()
    fresh.cookies["sab_session"] = cookie
    names = [item["name"] for item in fresh.get("/api/diagrams").json()["items"]]
    assert names == ["Survivor"]


def test_the_session_id_is_rotated_on_sign_in(anon_client, anon_session, google_ok):
    """
    A cookie value that was in circulation before anyone signed in must not still name
    a signed-in session afterwards.
    """
    state = begin(anon_client)
    response = anon_client.get(CALLBACK, {"state": state, "code": "code-1"})

    assert response.cookies["sab_session"].value != str(anon_session.id)
    assert not WorkspaceSession.objects.filter(pk=anon_session.id).exists()


def test_signing_in_as_a_different_account_does_not_inherit_the_previous_ones_work(
    account, mock_segment, google_configured
):
    """
    The breach case. A browser already signed in as one person, then signed in as
    another, must not hand the second person the first's diagrams.
    """
    google_configured.ALLOWED_EMAIL_DOMAINS = ["example.com"]
    first_session = WorkspaceSession.start_for_account(account)
    theirs = Diagram.objects.create(
        anon_scope=first_session.anon_scope, name="First person's", graph={"nodes": []}
    )

    client = APIClient()
    client.cookies["sab_session"] = str(first_session.id)

    mock_segment.add(
        responses_lib.POST,
        GOOGLE_TOKEN_URL,
        json={"id_token": fake_id_token(email="second@example.com", sub="second-sub")},
        status=200,
    )
    state = begin(client)
    response = client.get(CALLBACK, {"state": state, "code": "code-1"})
    assert "claimed" not in query_of(response)

    theirs.refresh_from_db()
    assert theirs.owner_id is None
    assert theirs.anon_scope == first_session.anon_scope

    second = Account.objects.get(email="second@example.com")
    assert not Diagram.objects.filter(owner=second).exists()


def test_signing_in_twice_claims_nothing_the_second_time(anon_client, anon_session, mock_segment, google_configured):
    Diagram.objects.create(anon_scope=anon_session.anon_scope, name="Once", graph={"nodes": []})
    for _ in range(2):
        mock_segment.add(
            responses_lib.POST, GOOGLE_TOKEN_URL, json={"id_token": fake_id_token()}, status=200
        )

    first_state = begin(anon_client)
    assert query_of(anon_client.get(CALLBACK, {"state": first_state, "code": "c1"}))["claimed"] == ["1"]

    OAuthLogin.objects.all().delete()
    second_state = begin(anon_client)
    assert "claimed" not in query_of(
        anon_client.get(CALLBACK, {"state": second_state, "code": "c2"})
    )

    assert Account.objects.count() == 1


# --- Session state and logging out ------------------------------------------


def test_get_session_reports_the_account(account_client, account):
    payload = account_client.get("/api/session").json()
    assert payload["hasSession"] is True
    assert payload["account"] == {
        "email": account.email,
        "name": account.name,
        "avatarUrl": "",
    }
    # Signed in but no workspace: both of these are false at once, which is exactly why
    # `hasSession` had to exist.
    assert payload["connected"] is False
    assert payload["anonymous"] is True


def test_logging_out_leaves_a_usable_anonymous_session(account_client, account_session):
    response = account_client.post("/api/auth/logout")
    assert response.status_code == 200
    assert response.json()["account"] is None

    # Rotated, so the signed-in cookie is inert afterwards.
    new_id = response.cookies["sab_session"].value
    assert new_id != str(account_session.id)
    assert not WorkspaceSession.objects.filter(pk=account_session.id).exists()

    replacement = WorkspaceSession.objects.get(pk=new_id)
    assert replacement.account is None
    assert replacement.anon_scope


def test_logging_out_does_not_expose_the_accounts_diagrams(account_client, account):
    Diagram.objects.create(owner=account, name="Private", graph={"nodes": []})
    response = account_client.post("/api/auth/logout")

    fresh = APIClient()
    fresh.cookies["sab_session"] = response.cookies["sab_session"].value
    assert fresh.get("/api/diagrams").json()["items"] == []


def test_logging_out_requires_a_session(client, db):
    assert client.post("/api/auth/logout").status_code == 401


# --- Invitations over the API -----------------------------------------------


def test_an_account_can_invite_and_is_told_no_mail_was_sent(account_client):
    response = account_client.post(
        "/api/invitations", {"email": "Guest@Elsewhere.com"}, format="json"
    )
    assert response.status_code == 201
    body = response.json()
    assert body["invitation"]["email"] == "guest@elsewhere.com"
    assert body["emailSent"] is False
    assert body["alreadyInvited"] is False


def test_inviting_the_same_address_twice_says_so(account_client):
    account_client.post("/api/invitations", {"email": "guest@elsewhere.com"}, format="json")
    again = account_client.post(
        "/api/invitations", {"email": "guest@elsewhere.com"}, format="json"
    )
    assert again.status_code == 200
    assert again.json()["alreadyInvited"] is True


def test_inviting_needs_an_account_not_merely_a_session(anon_client):
    response = anon_client.post("/api/invitations", {"email": "guest@elsewhere.com"}, format="json")
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "account_required"


def test_an_account_only_sees_invitations_it_sent(account_client, account, db):
    other = Account.objects.create(email="someone@example.com", google_sub="other-sub")
    invite(email="mine@elsewhere.com", invited_by=account)
    invite(email="theirs@elsewhere.com", invited_by=other)

    emails = [item["email"] for item in account_client.get("/api/invitations").json()["items"]]
    assert emails == ["mine@elsewhere.com"]


def test_every_session_endpoint_answers_with_the_same_shape(client, anon_client, account_client):
    """
    One payload shape, so the client has one thing to understand.

    Assembled inline in three places once, and they drifted -- the anonymous mint replied
    without `hasSession`, which the SPA reads to decide whether to mint. It therefore
    minted again, and the sign-in button vanished because `auth` was missing too.
    """
    expected = {"hasSession", "account", "workspace", "connected", "anonymous", "auth"}

    assert set(client.get("/api/session").json()) == expected
    assert set(client.post("/api/session/anonymous").json()) == expected
    assert set(anon_client.get("/api/session").json()) == expected
    assert set(anon_client.post("/api/session/anonymous").json()) == expected
    assert set(account_client.post("/api/auth/logout").json()) == expected
