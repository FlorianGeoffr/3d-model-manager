"""Printables account auth (Workstream A task A1). ``refresh`` parsing tests
are pure httpx-mock (no DB, no live network -- the ``/auth/refresh`` contract
below is LIVE-VERIFIED 2026-07-10 per ``app/services/printables_auth.py``'s
module docstring, and these tests pin THAT captured shape rather than
guessing); the storage/``get_access_token_sync`` tests exercise the real
``settings`` table via ``db_session`` (async, API side) and ``sync_session``
(worker side) -- both point at the same Postgres testcontainer, so a
sync-side write needs ``db_session.refresh(...)`` before an async-side read
sees it (SQLAlchemy identity-map staleness, same gotcha documented in
``tests/test_bambu_auth.py``).
"""

from __future__ import annotations

import time

import httpx
import pytest

from app.config import get_settings
from app.crypto import decrypt_secret
from app.models import Setting
from app.services import printables_auth

pytestmark = pytest.mark.usefixtures("data_dir")


@pytest.fixture(autouse=True)
def _clear_access_token_cache():
    # Module-level, process-wide cache (by design -- see printables_auth.py)
    # -- never let one test's cached access token leak into another's.
    printables_auth._ACCESS_TOKEN_CACHE.clear()
    yield
    printables_auth._ACCESS_TOKEN_CACHE.clear()


def _mock_client(handler):
    def factory() -> httpx.Client:
        return httpx.Client(
            base_url=printables_auth._BASE_URL, transport=httpx.MockTransport(handler)
        )

    return factory


def _refresh_response(
    *,
    access_token: str = "AT-new",
    refresh_token: str | None = "RT-rotated",
    access_token_exp: str | None = None,
) -> httpx.Response:
    """A live-shape 200 -- `{"ok": true}` body, tokens carried as Set-Cookie
    headers (see module docstring)."""
    headers: list[tuple[str, str]] = [("set-cookie", f"auth.access_token={access_token}; Path=/")]
    if refresh_token is not None:
        headers.append(("set-cookie", f"auth.refresh_token={refresh_token}; Path=/auth/refresh"))
    if access_token_exp is not None:
        headers.append(("set-cookie", f"auth.access_token_exp={access_token_exp}; Path=/"))
    headers.append(("set-cookie", "client-uid=irrelevant; Path=/"))
    return httpx.Response(200, json={"ok": True}, headers=headers)


# ---------------------------------------------------------------------------
# refresh -- pure parsing, no DB
# ---------------------------------------------------------------------------


def test_refresh_sends_token_only_as_cookie(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/auth/refresh"
        assert request.headers["cookie"] == "auth.refresh_token=RT-1"
        assert request.content == b"{}"
        return _refresh_response()

    monkeypatch.setattr(printables_auth, "_client", _mock_client(handler))
    printables_auth.refresh("RT-1")


def test_refresh_parses_tokens_out_of_set_cookie_headers(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return _refresh_response(access_token="AT-1", refresh_token="RT-2")

    monkeypatch.setattr(printables_auth, "_client", _mock_client(handler))
    token = printables_auth.refresh("RT-1")
    assert token.access_token == "AT-1"
    assert token.refresh_token == "RT-2"


def test_refresh_returns_the_rotated_refresh_token(monkeypatch):
    # Printables rotates the refresh token on EVERY call (live-verified) --
    # the new jti must come back, never the input token.
    def handler(request: httpx.Request) -> httpx.Response:
        return _refresh_response(access_token="AT-1", refresh_token="RT-rotated-2")

    monkeypatch.setattr(printables_auth, "_client", _mock_client(handler))
    token = printables_auth.refresh("RT-old")
    assert token.refresh_token == "RT-rotated-2"
    assert token.refresh_token != "RT-old"


def test_refresh_falls_back_to_input_token_if_no_rotation_cookie(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return _refresh_response(access_token="AT-1", refresh_token=None)

    monkeypatch.setattr(printables_auth, "_client", _mock_client(handler))
    token = printables_auth.refresh("RT-1")
    assert token.refresh_token == "RT-1"


def test_refresh_expires_at_comes_from_access_token_exp_cookie(monkeypatch):
    exp = time.time() + 7200

    def handler(request: httpx.Request) -> httpx.Response:
        return _refresh_response(access_token_exp=f"{exp:.6f}")

    monkeypatch.setattr(printables_auth, "_client", _mock_client(handler))
    token = printables_auth.refresh("RT-1")
    assert token.expires_at == pytest.approx(exp - printables_auth._EXPIRY_SAFETY_MARGIN_S, abs=1)


def test_refresh_expires_at_falls_back_to_jwt_exp_claim(monkeypatch):
    import base64
    import json

    exp = time.time() + 3600
    payload = base64.urlsafe_b64encode(json.dumps({"exp": exp}).encode()).decode().rstrip("=")
    jwt = f"header.{payload}.sig"

    def handler(request: httpx.Request) -> httpx.Response:
        return _refresh_response(access_token=jwt, access_token_exp=None)

    monkeypatch.setattr(printables_auth, "_client", _mock_client(handler))
    token = printables_auth.refresh("RT-1")
    assert token.expires_at == pytest.approx(exp - printables_auth._EXPIRY_SAFETY_MARGIN_S, abs=1)


def test_refresh_expires_at_falls_back_to_fixed_ttl_when_nothing_usable(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return _refresh_response(access_token="not-a-jwt", access_token_exp=None)

    monkeypatch.setattr(printables_auth, "_client", _mock_client(handler))
    before = time.time()
    token = printables_auth.refresh("RT-1")
    assert token.expires_at == pytest.approx(
        before + printables_auth._FALLBACK_ACCESS_TOKEN_TTL_S, abs=2
    )


def test_refresh_expires_at_falls_through_on_malformed_exp_cookie(monkeypatch):
    # A malformed `_exp` cookie must fall through to the JWT-claim/fixed-TTL
    # path, never raise.
    def handler(request: httpx.Request) -> httpx.Response:
        return _refresh_response(access_token="not-a-jwt", access_token_exp="not-a-number")

    monkeypatch.setattr(printables_auth, "_client", _mock_client(handler))
    before = time.time()
    token = printables_auth.refresh("RT-1")
    assert token.expires_at == pytest.approx(
        before + printables_auth._FALLBACK_ACCESS_TOKEN_TTL_S, abs=2
    )


def test_refresh_401_raises_printables_auth_error(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "No token provided"})

    monkeypatch.setattr(printables_auth, "_client", _mock_client(handler))
    with pytest.raises(printables_auth.PrintablesAuthError, match="invalid or expired"):
        printables_auth.refresh("bad-token")


def test_refresh_200_with_no_access_token_cookie_raises(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"ok": True})  # no Set-Cookie at all

    monkeypatch.setattr(printables_auth, "_client", _mock_client(handler))
    with pytest.raises(
        printables_auth.PrintablesAuthError, match="did not include an access token"
    ):
        printables_auth.refresh("RT-1")


# ---------------------------------------------------------------------------
# Storage: Fernet-encrypted at rest, masked shape, async+sync twins
# ---------------------------------------------------------------------------


async def test_set_and_get_printables_auth_roundtrip_is_encrypted_at_rest(db_session):
    settings = get_settings()
    await printables_auth.set_printables_auth(
        db_session, settings, username="makerfoo", user_id="5092991", refresh_token="RT-secret"
    )

    row = await db_session.get(Setting, printables_auth.SETTINGS_KEY)
    assert row.value["username"] == "makerfoo"
    assert row.value["user_id"] == "5092991"
    # M6-posture: Fernet ciphertext at rest, never the raw plaintext.
    assert row.value["refresh_token"] != "RT-secret"
    assert decrypt_secret(settings, row.value["refresh_token"]) == "RT-secret"

    state = await printables_auth.get_printables_auth(db_session, settings)
    assert state.username == "makerfoo"
    assert state.user_id == "5092991"
    assert state.refresh_token == "RT-secret"


async def test_get_printables_auth_when_nothing_stored_is_not_connected(db_session):
    state = await printables_auth.get_printables_auth(db_session, get_settings())
    assert state.refresh_token is None
    assert state.username is None
    assert state.user_id is None


async def test_clear_printables_auth_removes_the_row(db_session):
    settings = get_settings()
    await printables_auth.set_printables_auth(
        db_session, settings, username="makerfoo", user_id="5092991", refresh_token="RT-x"
    )
    await printables_auth.clear_printables_auth(db_session, settings)

    assert await db_session.get(Setting, printables_auth.SETTINGS_KEY) is None
    state = await printables_auth.get_printables_auth(db_session, settings)
    assert state.refresh_token is None


# ---------------------------------------------------------------------------
# get_access_token_sync -- the worker-facing seam the A4 importer calls
# ---------------------------------------------------------------------------


async def test_get_access_token_sync_raises_when_not_connected(db_session):
    from app.tasks.base import sync_session

    settings = get_settings()
    with sync_session() as s, pytest.raises(printables_auth.PrintablesAuthError):
        printables_auth.get_access_token_sync(s, settings)


async def test_get_access_token_sync_caches_then_refreshes_when_expired(db_session, monkeypatch):
    from app.tasks.base import sync_session

    settings = get_settings()
    await printables_auth.set_printables_auth(
        db_session, settings, username="makerfoo", user_id="5092991", refresh_token="RT-seed"
    )

    calls = {"n": 0}

    def fake_refresh(refresh_token: str) -> printables_auth.PrintablesAccessToken:
        calls["n"] += 1
        # Simulate Printables' real rotate-on-every-call behavior even in the
        # "cached" leg of this test, so the cache key tracks the token that
        # would actually be on file.
        return printables_auth.PrintablesAccessToken(
            access_token=f"AT-{calls['n']}",
            refresh_token=refresh_token,
            expires_at=time.time() + 3600,
        )

    monkeypatch.setattr(printables_auth, "refresh", fake_refresh)

    with sync_session() as s:
        first = printables_auth.get_access_token_sync(s, settings)
        second = printables_auth.get_access_token_sync(s, settings)
    assert first == second == "AT-1"
    assert calls["n"] == 1  # cached -- no second refresh() call

    # Force the cached entry stale and confirm a fresh refresh happens.
    printables_auth._ACCESS_TOKEN_CACHE["RT-seed"] = ("AT-1", time.time() - 1)
    with sync_session() as s:
        third = printables_auth.get_access_token_sync(s, settings)
    assert third == "AT-2"
    assert calls["n"] == 2


async def test_get_access_token_sync_persists_rotated_refresh_token_before_caching(
    db_session, monkeypatch
):
    """The refresh token rotates on EVERY Printables call -- persist the new
    one BEFORE caching the new access token (else `set_*`'s cache-clear could
    wipe out the entry we just added). Assert both halves: the stored
    `Setting` row holds the new token, AND the cache then serves the new
    access token without a second HTTP call."""
    from app.tasks.base import sync_session

    settings = get_settings()
    await printables_auth.set_printables_auth(
        db_session, settings, username="makerfoo", user_id="5092991", refresh_token="RT-old"
    )

    calls = {"n": 0}

    def fake_refresh(refresh_token: str) -> printables_auth.PrintablesAccessToken:
        assert refresh_token == "RT-old"
        calls["n"] += 1
        return printables_auth.PrintablesAccessToken(
            access_token="AT-1", refresh_token="RT-new", expires_at=time.time() + 3600
        )

    monkeypatch.setattr(printables_auth, "refresh", fake_refresh)

    with sync_session() as s:
        token = printables_auth.get_access_token_sync(s, settings)
    assert token == "AT-1"
    assert calls["n"] == 1

    row = await db_session.get(Setting, printables_auth.SETTINGS_KEY)
    await db_session.refresh(row)  # sync-session write -- refresh past the identity map
    assert decrypt_secret(settings, row.value["refresh_token"]) == "RT-new"
    # username/user_id preserved across the rotation-triggered persist.
    assert row.value["username"] == "makerfoo"
    assert row.value["user_id"] == "5092991"

    # The cache now serves AT-1 keyed by the ROTATED token, with no second
    # HTTP call -- proves persistence happened before the cache write, not
    # after (see module docstring's ordering rationale).
    with sync_session() as s:
        second = printables_auth.get_access_token_sync(s, settings)
    assert second == "AT-1"
    assert calls["n"] == 1
