"""Bambu Lab account auth (Workstream B task B2). Login/verify/refresh
parsing tests are pure httpx-mock (no DB); the storage/`get_access_token_
sync` tests exercise the real `settings` table via `db_session` (async, API
side) and `sync_session` (worker side) -- both point at the same Postgres
testcontainer, so a sync-side write needs `db_session.refresh(...)` before
an async-side read sees it (SQLAlchemy identity-map staleness, same
gotcha documented in tests/test_scanner.py).

NOTE on fixture realism: the login/MFA/refresh response bodies mocked below
are DOCUMENTED, NOT LIVE-CAPTURED (see app/services/bambu_auth.py's module
docstring) -- no real Bambu account was available to verify the exact
success/MFA-challenge shape. These tests pin this module's OWN tolerant
parsing behavior, not a verified real API contract.
"""

from __future__ import annotations

import json
import time

import httpx
import pytest

from app.config import get_settings
from app.crypto import decrypt_secret
from app.models import Setting
from app.services import bambu_auth

pytestmark = pytest.mark.usefixtures("data_dir")


@pytest.fixture(autouse=True)
def _clear_access_token_cache():
    # Module-level, process-wide cache (by design -- see bambu_auth.py) --
    # never let one test's cached access token leak into another's.
    bambu_auth._ACCESS_TOKEN_CACHE.clear()
    yield
    bambu_auth._ACCESS_TOKEN_CACHE.clear()


def _mock_client(handler):
    def factory(region: str = "global") -> httpx.Client:
        return httpx.Client(
            base_url=bambu_auth.base_url_for_region(region),
            transport=httpx.MockTransport(handler),
        )

    return factory


# ---------------------------------------------------------------------------
# login / verify_code / refresh -- pure parsing, no DB
# ---------------------------------------------------------------------------


def test_login_success_returns_connected_result(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/user-service/user/login"
        body = json.loads(request.content)
        assert body == {"account": "a@b.com", "password": "hunter2"}
        return httpx.Response(200, json={"accessToken": "AT1", "refreshToken": "RT1"})

    monkeypatch.setattr(bambu_auth, "_client", _mock_client(handler))
    result = bambu_auth.login("a@b.com", "hunter2")
    assert result.status == "connected"
    assert result.access_token == "AT1"
    assert result.refresh_token == "RT1"


def test_login_bad_credentials_raises(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"code": 1, "error": "Incorrect account or password."})

    monkeypatch.setattr(bambu_auth, "_client", _mock_client(handler))
    with pytest.raises(bambu_auth.BambuAuthError, match="Incorrect account or password"):
        bambu_auth.login("a@b.com", "wrong")


def test_login_mfa_challenge_then_verify_completes(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if "password" in body:
            # DOCUMENTED-NOT-LIVE MFA challenge shape (full-design spec line
            # 230's `loginType:"verifyCode"`) -- no token fields present.
            return httpx.Response(200, json={"loginType": "verifyCode", "tfaKey": "ctx-123"})
        assert body["account"] == "a@b.com"
        assert body["code"] == "000000"
        assert body["tfaKey"] == "ctx-123"  # continuation context echoed back
        return httpx.Response(200, json={"accessToken": "AT2", "refreshToken": "RT2"})

    monkeypatch.setattr(bambu_auth, "_client", _mock_client(handler))

    first = bambu_auth.login("a@b.com", "hunter2")
    assert first.status == "mfa_required"
    assert first.mfa_context == {"loginType": "verifyCode", "tfaKey": "ctx-123"}

    second = bambu_auth.verify_code("a@b.com", "000000", "global", first.mfa_context)
    assert second.status == "connected"
    assert second.access_token == "AT2"
    assert second.refresh_token == "RT2"


def test_verify_code_rejected_raises(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"loginType": "verifyCode"})  # still no tokens -> bad code

    monkeypatch.setattr(bambu_auth, "_client", _mock_client(handler))
    with pytest.raises(bambu_auth.BambuAuthError):
        bambu_auth.verify_code("a@b.com", "999999", "global", {})


def test_mfa_context_strips_token_like_keys_but_keeps_continuation(monkeypatch):
    # An MFA challenge that (per the UNVERIFIED shape) also carries some
    # token-like values must NOT leak them into mfa_context (which flows to
    # the browser), while the real continuation fields (tfaKey, loginType)
    # must survive so verify still works.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "loginType": "verifyCode",
                "tfaKey": "ctx-123",
                "sessionToken": "leak-me-1",
                "accessToken": "leak-me-2",  # present but not paired w/ refresh -> not "connected"
                "password": "leak-me-3",
                "secret": "leak-me-4",
            },
        )

    monkeypatch.setattr(bambu_auth, "_client", _mock_client(handler))
    result = bambu_auth.login("a@b.com", "hunter2")
    assert result.status == "mfa_required"
    # Continuation kept (note: tfaKey ends in "Key" -- must survive).
    assert result.mfa_context == {"loginType": "verifyCode", "tfaKey": "ctx-123"}
    # Nothing token-like remains anywhere in the returned context.
    serialized = json.dumps(result.mfa_context)
    assert "leak-me" not in serialized


def test_refresh_returns_new_access_token(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/user-service/user/refreshtoken"
        body = json.loads(request.content)
        assert body == {"refreshToken": "RT1"}
        return httpx.Response(200, json={"accessToken": "AT-new", "expiresIn": 3600})

    monkeypatch.setattr(bambu_auth, "_client", _mock_client(handler))
    token = bambu_auth.refresh("RT1", "global")
    assert token.access_token == "AT-new"
    assert token.refresh_token == "RT1"  # unchanged -- response didn't rotate it
    assert token.expires_at > time.time()


def test_refresh_can_rotate_the_refresh_token(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"accessToken": "AT-new", "refreshToken": "RT-rotated"})

    monkeypatch.setattr(bambu_auth, "_client", _mock_client(handler))
    token = bambu_auth.refresh("RT1", "global")
    assert token.refresh_token == "RT-rotated"


def test_refresh_invalid_token_raises(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "invalid token"})

    monkeypatch.setattr(bambu_auth, "_client", _mock_client(handler))
    with pytest.raises(bambu_auth.BambuAuthError):
        bambu_auth.refresh("bad-token", "global")


# ---------------------------------------------------------------------------
# Storage: Fernet-encrypted at rest, masked shape, async+sync twins
# ---------------------------------------------------------------------------


async def test_set_and_get_bambu_auth_roundtrip_is_encrypted_at_rest(db_session):
    settings = get_settings()
    await bambu_auth.set_bambu_auth(
        db_session, settings, account="a@b.com", region="global", refresh_token="RT-secret"
    )

    row = await db_session.get(Setting, bambu_auth.SETTINGS_KEY)
    assert row.value["account"] == "a@b.com"
    assert row.value["region"] == "global"
    # M6-posture: Fernet ciphertext at rest, never the raw plaintext.
    assert row.value["refresh_token"] != "RT-secret"
    assert decrypt_secret(settings, row.value["refresh_token"]) == "RT-secret"

    state = await bambu_auth.get_bambu_auth(db_session, settings)
    assert state.account == "a@b.com"
    assert state.region == "global"
    assert state.refresh_token == "RT-secret"


async def test_get_bambu_auth_when_nothing_stored_is_not_connected(db_session):
    state = await bambu_auth.get_bambu_auth(db_session, get_settings())
    assert state.refresh_token is None
    assert state.account is None
    assert state.region == "global"


async def test_clear_bambu_auth_removes_the_row(db_session):
    settings = get_settings()
    await bambu_auth.set_bambu_auth(
        db_session, settings, account="a@b.com", region="global", refresh_token="RT-x"
    )
    await bambu_auth.clear_bambu_auth(db_session, settings)

    assert await db_session.get(Setting, bambu_auth.SETTINGS_KEY) is None
    state = await bambu_auth.get_bambu_auth(db_session, settings)
    assert state.refresh_token is None


# ---------------------------------------------------------------------------
# get_access_token_sync -- the worker-facing seam MakerWorld calls
# ---------------------------------------------------------------------------


async def test_get_access_token_sync_raises_when_not_connected(db_session):
    from app.tasks.base import sync_session

    settings = get_settings()
    with sync_session() as s, pytest.raises(bambu_auth.BambuAuthError):
        bambu_auth.get_access_token_sync(s, settings)


async def test_get_access_token_sync_caches_then_refreshes_when_expired(db_session, monkeypatch):
    from app.tasks.base import sync_session

    settings = get_settings()
    await bambu_auth.set_bambu_auth(
        db_session, settings, account="a@b.com", region="global", refresh_token="RT-seed"
    )

    calls = {"n": 0}

    def fake_refresh(refresh_token: str, region: str) -> bambu_auth.BambuAccessToken:
        calls["n"] += 1
        return bambu_auth.BambuAccessToken(
            access_token=f"AT-{calls['n']}",
            refresh_token=refresh_token,
            expires_at=time.time() + 3600,
        )

    monkeypatch.setattr(bambu_auth, "refresh", fake_refresh)

    with sync_session() as s:
        first = bambu_auth.get_access_token_sync(s, settings)
        second = bambu_auth.get_access_token_sync(s, settings)
    assert first == second == "AT-1"
    assert calls["n"] == 1  # cached -- no second refresh() call

    # Force the cached entry stale and confirm a fresh refresh happens.
    bambu_auth._ACCESS_TOKEN_CACHE["RT-seed"] = ("AT-1", time.time() - 1)
    with sync_session() as s:
        third = bambu_auth.get_access_token_sync(s, settings)
    assert third == "AT-2"
    assert calls["n"] == 2


async def test_get_access_token_sync_persists_a_rotated_refresh_token(db_session, monkeypatch):
    from app.tasks.base import sync_session

    settings = get_settings()
    await bambu_auth.set_bambu_auth(
        db_session, settings, account="a@b.com", region="global", refresh_token="RT-old"
    )

    def fake_refresh(refresh_token: str, region: str) -> bambu_auth.BambuAccessToken:
        assert refresh_token == "RT-old"
        return bambu_auth.BambuAccessToken(
            access_token="AT-1", refresh_token="RT-new", expires_at=time.time() + 3600
        )

    monkeypatch.setattr(bambu_auth, "refresh", fake_refresh)

    with sync_session() as s:
        token = bambu_auth.get_access_token_sync(s, settings)
    assert token == "AT-1"

    row = await db_session.get(Setting, bambu_auth.SETTINGS_KEY)
    await db_session.refresh(row)  # sync-session write -- refresh past the identity map
    assert decrypt_secret(settings, row.value["refresh_token"]) == "RT-new"
