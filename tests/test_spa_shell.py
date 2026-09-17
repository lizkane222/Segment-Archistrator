"""
The SPA shell, and why it must never be cached.

Vite content-hashes every asset filename and builds with `emptyOutDir`, so each build
replaces `assets/index-<hash>.css` with a differently-named file and deletes the one
before it. `index.html` is the only document that names those files -- so a browser
holding a cached copy of it asks for hashes that no longer exist and gets a 404 for the
stylesheet, the script, or both. What the user sees is the app loading unstyled, or not at
all, with nothing anywhere saying why; what the server sees is a 404 for a file it did
once have.

Hence one header, and a test for it: the hashed assets under /static/ are safe to cache
forever precisely *because* their names change, and the document naming them is safe to
cache for no time at all.
"""

import pytest


@pytest.fixture
def spa(client, settings, tmp_path):
    """
    Serve a stand-in build, so the test does not depend on `npm run build` having run.

    `spa_index` reads `BASE_DIR/static/spa/index.html` directly, so pointing BASE_DIR at a
    temporary tree is the whole of the setup. It also exercises the real branch: with no
    file there the view answers 503, which is the other case that must not be cached.
    """
    settings.BASE_DIR = tmp_path
    return client


def test_the_shell_is_never_cached(spa, tmp_path):
    build = tmp_path / "static" / "spa"
    build.mkdir(parents=True)
    (build / "index.html").write_text(
        '<!doctype html><link rel="stylesheet" href="/static/assets/index-abc123.css">'
    )

    response = spa.get("/")

    assert response.status_code == 200
    assert "no-store" in response["Cache-Control"]
    assert response["Pragma"] == "no-cache"


def test_the_not_built_page_is_never_cached_either(spa):
    """
    The 503 has to be as uncacheable as the shell.

    Otherwise the first visit after a fresh clone poisons the cache with "Frontend not
    built" and the page keeps saying so after the build has run -- which reads as the
    build having failed.
    """
    response = spa.get("/")

    assert response.status_code == 503
    assert "no-store" in response["Cache-Control"]


def test_client_side_routes_get_the_shell(spa, tmp_path):
    """A deep link is the SPA's to resolve, so it has to reach the shell rather than 404."""
    build = tmp_path / "static" / "spa"
    build.mkdir(parents=True)
    (build / "index.html").write_text("<!doctype html><div id=root></div>")

    response = spa.get("/some/client/route")

    assert response.status_code == 200
    assert b"id=root" in response.content


def test_the_shell_plants_the_csrf_cookie(spa, tmp_path):
    """
    The reason `spa_index` is a function and not a static file: the first page load has to
    leave a csrftoken behind, or the app's first POST -- minting a session -- is refused.
    """
    build = tmp_path / "static" / "spa"
    build.mkdir(parents=True)
    (build / "index.html").write_text("<!doctype html>")

    response = spa.get("/")

    assert response.cookies["csrftoken"].value
