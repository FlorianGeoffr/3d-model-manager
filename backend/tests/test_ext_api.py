"""``/ext/*`` browser-extension endpoints (M10 Workstream A): bearer-token
auth (``require_api_token``), the three endpoints themselves, and -- most
importantly -- that the two auth planes (session cookie vs. bearer token)
don't leak into each other (SPEC: a leaked extension token must not unlock
the session-gated API, and a stolen session cookie can't be replayed here).
"""

from __future__ import annotations

import httpx
import pytest

from app.services import api_tokens
from tests import corpus

pytestmark = pytest.mark.usefixtures("library_root", "data_dir")


@pytest.fixture
async def ext_token(db_session) -> str:
    token, _ = await api_tokens.mint(db_session, label="Chrome extension")
    return token


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def test_ping_with_valid_bearer_is_200(client: httpx.AsyncClient, ext_token: str):
    r = await client.get("/api/ext/ping", headers=_bearer(ext_token))
    assert r.status_code == 200 and r.json() == {"ok": True}


async def test_ping_with_no_authorization_header_is_401(client: httpx.AsyncClient):
    r = await client.get("/api/ext/ping")
    assert r.status_code == 401
    assert r.headers["www-authenticate"] == "Bearer"


async def test_ping_with_malformed_authorization_header_is_401(client: httpx.AsyncClient):
    r = await client.get("/api/ext/ping", headers={"Authorization": "not-a-bearer-token"})
    assert r.status_code == 401


async def test_ping_with_revoked_token_is_401(
    client: httpx.AsyncClient, db_session, ext_token: str
):
    row = (await api_tokens.list_tokens(db_session))[0]
    assert await api_tokens.revoke(db_session, row.id) is True

    r = await client.get("/api/ext/ping", headers=_bearer(ext_token))
    assert r.status_code == 401


async def test_ping_with_session_cookie_only_is_401(authenticated_client: httpx.AsyncClient):
    """Scope isolation: a session cookie (no bearer) must not authenticate
    against the /ext plane."""
    r = await authenticated_client.get("/api/ext/ping")
    assert r.status_code == 401


async def test_session_gated_route_with_bearer_only_is_401(
    client: httpx.AsyncClient, ext_token: str
):
    """Scope isolation, the other direction: a bearer token (no session
    cookie) must not authenticate against the session-gated API."""
    r = await client.get("/api/settings/import-tokens", headers=_bearer(ext_token))
    assert r.status_code == 401


async def test_create_import_creates_and_dedups(
    client: httpx.AsyncClient, ext_token: str, fake_import
):
    fake_import.files = {"cube.stl": corpus.box_stl()}
    first = await client.post(
        "/api/ext/imports", json={"url": "https://fake.test/thing/42"}, headers=_bearer(ext_token)
    )
    assert first.status_code == 201, first.text
    body = first.json()
    assert body["site"] == "thingiverse" and body["external_id"] == "42"

    second = await client.post(
        "/api/ext/imports", json={"url": "https://fake.test/thing/42"}, headers=_bearer(ext_token)
    )
    assert second.status_code == 200, second.text  # deduped: nothing new created
    assert second.json()["id"] == body["id"]


async def test_create_import_requires_bearer(client: httpx.AsyncClient):
    r = await client.post("/api/ext/imports", json={"url": "https://fake.test/thing/42"})
    assert r.status_code == 401


async def test_set_makerworld_credential_preserves_thingiverse_token(
    client: httpx.AsyncClient, db_session, ext_token: str
):
    from app.config import get_settings
    from app.services import import_tokens

    await import_tokens.set_import_tokens(
        db_session, get_settings(), thingiverse_token="tv-tok", makerworld_token=None
    )

    r = await client.post(
        "/api/ext/credentials/makerworld",
        json={"token": "mw-cookie-value"},
        headers=_bearer(ext_token),
    )
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert "mw-cookie-value" not in r.text  # never echoed back

    tokens = await import_tokens.get_import_tokens(db_session, get_settings())
    assert tokens.makerworld_token == "mw-cookie-value"
    assert tokens.thingiverse_token == "tv-tok"  # clobber guard: untouched


async def test_set_makerworld_credential_requires_bearer(client: httpx.AsyncClient):
    r = await client.post("/api/ext/credentials/makerworld", json={"token": "x"})
    assert r.status_code == 401
