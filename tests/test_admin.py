"""
Admin mode: who may publish to everyone's Reference architectures, and who may make administrators.

Every rule is checked server-side. The browser's admin switch only decides whether controls are drawn,
so these tests talk to the endpoints as each kind of caller.
"""

import pytest

from apps.diagrams.models import Template
from tests.test_user_templates import GENERIC, OWNED, signed_in

pytestmark = pytest.mark.django_db


@pytest.fixture
def owner(settings):
    settings.ADMIN_EMAILS = ["boss@twilio.com"]
    return signed_in("boss@twilio.com", "boss")


def test_an_ordinary_user_is_refused_everything():
    client, _ = signed_in("a@twilio.com", "a")
    assert client.get("/api/admin/users").status_code == 403
    assert client.get("/api/admin/templates").status_code == 403
    assert client.post("/api/admin/templates", {"name": "X", "graph": GENERIC}, format="json").status_code == 403


def test_the_session_says_who_is_an_administrator(owner):
    client, _ = owner
    assert client.get("/api/session").json()["account"]["isAdmin"] is True
    other, _ = signed_in("a@twilio.com", "a")
    assert other.get("/api/session").json()["account"]["isAdmin"] is False


def test_an_owner_sees_every_user_and_can_make_one_an_admin(owner):
    client, _ = owner
    _, someone = signed_in("a@twilio.com", "a")
    users = {u["email"]: u for u in client.get("/api/admin/users").json()["items"]}
    assert users["boss@twilio.com"]["isOwner"] and not users["a@twilio.com"]["isAdmin"]

    assert client.patch(f"/api/admin/users/{someone.id}", {"isAdmin": True}, format="json").status_code == 200
    someone.refresh_from_db()
    assert someone.is_admin


def test_a_new_admin_has_the_same_powers_but_cannot_demote_owners_or_themselves(owner):
    _, boss = owner
    client, admin = signed_in("b@twilio.com", "b")
    admin.is_admin = True
    admin.save()
    assert client.get("/api/admin/users").status_code == 200
    assert client.patch(f"/api/admin/users/{boss.id}", {"isAdmin": False}, format="json").status_code == 400
    assert client.patch(f"/api/admin/users/{admin.id}", {"isAdmin": False}, format="json").status_code == 400


def test_an_owner_can_demote_an_admin(owner):
    client, _ = owner
    _, admin = signed_in("b@twilio.com", "b")
    admin.is_admin = True
    admin.save()
    assert client.patch(f"/api/admin/users/{admin.id}", {"isAdmin": False}, format="json").status_code == 200
    admin.refresh_from_db()
    assert not admin.has_admin_rights


def test_a_published_diagram_reaches_everyone_and_can_be_withdrawn(owner):
    client, _ = owner
    made = client.post("/api/admin/templates", {"name": "Hello", "graph": GENERIC}, format="json")
    assert made.status_code == 201
    key = made.json()["key"]
    assert key.startswith("admin-")

    other, _ = signed_in("a@twilio.com", "a")
    assert key in {t["key"] for t in other.get("/api/templates").json()["items"]}

    client.patch(f"/api/admin/templates/{key}", {"published": False}, format="json")
    assert key not in {t["key"] for t in other.get("/api/templates").json()["items"]}
    assert other.get(f"/api/templates/{key}").status_code == 404
    assert key in {t["key"] for t in client.get("/api/admin/templates").json()["items"]}


def test_a_diagram_carrying_a_workspaces_data_cannot_be_published(owner):
    client, _ = owner
    assert client.post("/api/admin/templates", {"name": "X", "graph": OWNED}, format="json").status_code == 400


def test_a_shipped_template_can_be_withdrawn_but_not_edited_or_deleted(owner):
    client, _ = owner
    Template.objects.create(key="shipped", name="Shipped", graph=GENERIC, is_builtin=True)
    assert client.patch("/api/admin/templates/shipped", {"published": False}, format="json").status_code == 200
    assert client.patch("/api/admin/templates/shipped", {"name": "New"}, format="json").status_code == 400
    assert client.delete("/api/admin/templates/shipped").status_code == 400


def test_pruning_leaves_published_ones_alone(owner):
    from django.core.management import call_command

    client, _ = owner
    key = client.post("/api/admin/templates", {"name": "Hello", "graph": GENERIC}, format="json").json()["key"]
    call_command("seed_templates", "--prune", verbosity=0)
    assert Template.objects.filter(key=key).exists()
