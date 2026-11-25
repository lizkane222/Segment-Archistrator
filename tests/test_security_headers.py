import pytest
from rest_framework.test import APIClient

pytestmark = pytest.mark.django_db


def test_the_api_is_never_cacheable(auth_client):
    response = auth_client.get("/api/diagrams")
    assert response["Cache-Control"] == "no-store"
    assert "Cookie" in response["Vary"]


def test_even_an_error_from_the_api_is_not_cacheable():
    assert APIClient().get("/api/diagrams")["Cache-Control"] == "no-store"


def test_the_document_carries_a_csp(client):
    response = client.get("/")
    csp = response["Content-Security-Policy"]
    for directive in ("default-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'"):
        assert directive in csp
    assert "unsafe-inline" not in csp.split("script-src")[1].split(";")[0]


def test_the_csp_can_be_report_only(client, settings):
    settings.CSP_REPORT_ONLY = True
    response = client.get("/")
    assert "Content-Security-Policy-Report-Only" in response
    assert "Content-Security-Policy" not in response


def test_the_health_check_answers_to_any_host(settings):
    """EB's check arrives addressed to the instance IP, which is never in ALLOWED_HOSTS."""
    response = APIClient().get("/api/health", HTTP_HOST="10.0.12.34")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_the_health_check_is_not_redirected_to_https(settings):
    """After HTTPS is on, the check still comes in over plain HTTP from the load balancer."""
    settings.SECURE_SSL_REDIRECT = True
    settings.SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
    response = APIClient().get("/api/health", HTTP_HOST="10.0.12.34")
    assert response.status_code == 200


def test_nothing_else_skips_host_validation():
    assert APIClient().get("/api/session", HTTP_HOST="evil.example").status_code == 400
