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
    # The headline fix depends on the connected path always yielding an
    # expiry estimate -- `verify_code` shares `_parse_login_response`, so it
    # gets this for free (see the MFA-then-verify test below).
    assert result.expires_at is not None
    assert result.expires_at > time.time()


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
    assert second.expires_at is not None  # MFA path gets the expiry estimate for free


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


def test_refresh_invalid_token_raises_with_expired_kind(monkeypatch):
    # `BambuAuthError.kind` is what `get_access_token_sync` (and eventually
    # `_require_bambu_session`) use to pick the "expired" flavor WITHOUT
    # string-matching the message.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"error": "invalid token"})

    monkeypatch.setattr(bambu_auth, "_client", _mock_client(handler))
    with pytest.raises(bambu_auth.BambuAuthError) as exc_info:
        bambu_auth.refresh("bad-token", "global")
    assert exc_info.value.kind == "expired"


def test_login_bad_credentials_error_has_no_kind(monkeypatch):
    # A 400 (bad credentials) is neither "not_configured" nor "expired" --
    # it's a live login attempt Bambu rejected, not a stored-session problem.
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json={"code": 1, "error": "Incorrect account or password."})

    monkeypatch.setattr(bambu_auth, "_client", _mock_client(handler))
    with pytest.raises(bambu_auth.BambuAuthError) as exc_info:
        bambu_auth.login("a@b.com", "wrong")
    assert exc_info.value.kind is None


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


async def test_set_bambu_auth_stores_access_token_encrypted_with_float_expiry(db_session):
    settings = get_settings()
    expiry = time.time() + 3600
    await bambu_auth.set_bambu_auth(
        db_session,
        settings,
        account="a@b.com",
        region="global",
        refresh_token="RT-secret",
        access_token="AT-secret",
        access_expires_at=expiry,
    )

    row = await db_session.get(Setting, bambu_auth.SETTINGS_KEY)
    # M6-posture parity with the refresh token: Fernet ciphertext at rest,
    # never the raw plaintext, and the expiry is a plain (non-secret) float.
    assert row.value["access_token"] != "AT-secret"
    assert decrypt_secret(settings, row.value["access_token"]) == "AT-secret"
    assert isinstance(row.value["access_expires_at"], float)
    assert row.value["access_expires_at"] == expiry

    state = await bambu_auth.get_bambu_auth(db_session, settings)
    assert state.access_token == "AT-secret"
    assert state.access_expires_at == expiry


async def test_set_bambu_auth_omits_access_token_keys_when_none_given(db_session):
    """A caller with only a refresh token (should not happen in practice,
    per the module's own note, but tolerated) must not write null/garbage
    access-token keys onto the row."""
    settings = get_settings()
    await bambu_auth.set_bambu_auth(
        db_session, settings, account="a@b.com", region="global", refresh_token="RT-only"
    )

    row = await db_session.get(Setting, bambu_auth.SETTINGS_KEY)
    assert "access_token" not in row.value
    assert "access_expires_at" not in row.value

    state = await bambu_auth.get_bambu_auth(db_session, settings)
    assert state.access_token is None
    assert state.access_expires_at is None


def test_has_valid_access_token():
    now = time.time()
    assert bambu_auth.BambuAuthState(
        access_token="AT", access_expires_at=now + 60
    ).has_valid_access_token(now)
    assert not bambu_auth.BambuAuthState(
        access_token="AT", access_expires_at=now - 1
    ).has_valid_access_token(now)
    no_token = bambu_auth.BambuAuthState(access_token=None, access_expires_at=now + 60)
    assert not no_token.has_valid_access_token(now)
    no_expiry = bambu_auth.BambuAuthState(access_token="AT", access_expires_at=None)
    assert not no_expiry.has_valid_access_token(now)


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
# refresh_failed_at marker -- expiry-banner UX (mark_refresh_failed/_sync,
# clear_refresh_failed/_sync, and set_bambu_auth's implicit whole-row clear)
# ---------------------------------------------------------------------------


async def test_mark_refresh_failed_stamps_a_non_secret_timestamp(db_session):
    settings = get_settings()
    await bambu_auth.set_bambu_auth(
        db_session, settings, account="a@b.com", region="global", refresh_token="RT-x"
    )
    await bambu_auth.mark_refresh_failed(db_session, settings, "RT-x")

    row = await db_session.get(Setting, bambu_auth.SETTINGS_KEY)
    assert row.value["refresh_failed_at"]  # non-empty ISO string
    assert "RT-x" not in row.value["refresh_failed_at"]  # never a token value

    state = await bambu_auth.get_bambu_auth(db_session, settings)
    assert state.refresh_failed_at
    # The refresh token itself must still be readable -- the marker is
    # patched onto the row alongside it, not a wholesale overwrite.
    assert state.refresh_token == "RT-x"


async def test_mark_refresh_failed_skips_when_the_stored_token_no_longer_matches(db_session):
    """Compare-and-set (post-review fix M1): the row's refresh token has
    already moved on (e.g. a concurrent successful refresh rotated it) by
    the time this call goes to stamp the marker for the OLD, now-rejected
    token. Must be a no-op -- stamping here would falsely mark an account
    that's actually fine as `needs_reconnect`."""
    settings = get_settings()
    await bambu_auth.set_bambu_auth(
        db_session, settings, account="a@b.com", region="global", refresh_token="RT-current"
    )
    await bambu_auth.mark_refresh_failed(db_session, settings, "RT-stale-rejected")

    row = await db_session.get(Setting, bambu_auth.SETTINGS_KEY)
    assert "refresh_failed_at" not in row.value

    state = await bambu_auth.get_bambu_auth(db_session, settings)
    assert state.refresh_failed_at is None
    assert state.refresh_token == "RT-current"  # untouched


async def test_mark_refresh_failed_sync_skips_when_the_stored_token_no_longer_matches(db_session):
    from app.tasks.base import sync_session

    settings = get_settings()
    with sync_session() as s:
        bambu_auth.set_bambu_auth_sync(
            s, settings, account="a@b.com", region="global", refresh_token="RT-current"
        )
        bambu_auth.mark_refresh_failed_sync(s, settings, "RT-stale-rejected")
        row = s.get(Setting, bambu_auth.SETTINGS_KEY)
        assert "refresh_failed_at" not in row.value


async def test_mark_refresh_failed_sync_stamps_when_the_stored_token_still_matches(db_session):
    from app.tasks.base import sync_session

    settings = get_settings()
    with sync_session() as s:
        bambu_auth.set_bambu_auth_sync(
            s, settings, account="a@b.com", region="global", refresh_token="RT-x"
        )
        bambu_auth.mark_refresh_failed_sync(s, settings, "RT-x")
        row = s.get(Setting, bambu_auth.SETTINGS_KEY)
        assert row.value["refresh_failed_at"]


async def test_mark_refresh_failed_is_a_noop_when_nothing_connected(db_session):
    settings = get_settings()
    await bambu_auth.mark_refresh_failed(db_session, settings, "RT-anything")  # must not raise
    assert await db_session.get(Setting, bambu_auth.SETTINGS_KEY) is None


async def test_clear_refresh_failed_removes_the_marker_only(db_session):
    settings = get_settings()
    await bambu_auth.set_bambu_auth(
        db_session, settings, account="a@b.com", region="global", refresh_token="RT-x"
    )
    await bambu_auth.mark_refresh_failed(db_session, settings, "RT-x")
    await bambu_auth.clear_refresh_failed(db_session, settings)

    row = await db_session.get(Setting, bambu_auth.SETTINGS_KEY)
    assert "refresh_failed_at" not in row.value
    assert row.value["account"] == "a@b.com"  # untouched

    state = await bambu_auth.get_bambu_auth(db_session, settings)
    assert state.refresh_failed_at is None
    assert state.refresh_token == "RT-x"


async def test_set_bambu_auth_implicitly_clears_a_stale_marker(db_session):
    """A fresh login (`set_bambu_auth`) always replaces the whole row --
    that must clear any `refresh_failed_at` left over from a PREVIOUS
    (now-superseded) connection, without needing an explicit clear call."""
    settings = get_settings()
    await bambu_auth.set_bambu_auth(
        db_session, settings, account="a@b.com", region="global", refresh_token="RT-old"
    )
    await bambu_auth.mark_refresh_failed(db_session, settings, "RT-old")

    await bambu_auth.set_bambu_auth(
        db_session, settings, account="a@b.com", region="global", refresh_token="RT-new"
    )

    state = await bambu_auth.get_bambu_auth(db_session, settings)
    assert state.refresh_failed_at is None
    assert state.refresh_token == "RT-new"


# ---------------------------------------------------------------------------
# get_access_token_sync -- the worker-facing seam MakerWorld calls
# ---------------------------------------------------------------------------


async def test_get_access_token_sync_raises_when_not_connected(db_session):
    from app.tasks.base import sync_session

    settings = get_settings()
    with sync_session() as s, pytest.raises(bambu_auth.BambuAuthError) as exc_info:
        bambu_auth.get_access_token_sync(s, settings)
    assert exc_info.value.kind == "not_configured"


async def test_get_access_token_sync_caches_then_refreshes_when_stored_token_expires(
    db_session, monkeypatch
):
    """Was ``..._caches_then_refreshes_when_expired`` -- staleing only the
    in-memory cache used to be enough to force a fresh ``refresh()`` call.
    Post-fix, the persisted access token is the real source of truth (that's
    the whole point): a merely-evicted cache entry next to a still-valid
    STORED access token must NOT trigger a network call any more, so this
    now expires the persisted token itself (as a real expiry eventually
    would) to exercise the same "cache miss -> refresh" path honestly."""
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

    # Expire the PERSISTED access token (set_bambu_auth also clears the
    # in-memory cache as a side effect -- see its docstring) and confirm a
    # fresh refresh happens.
    await bambu_auth.set_bambu_auth(
        db_session,
        settings,
        account="a@b.com",
        region="global",
        refresh_token="RT-seed",
        access_token="AT-1",
        access_expires_at=time.time() - 1,
    )
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


async def test_get_access_token_sync_stamps_refresh_failed_at_on_a_dead_refresh_token(
    db_session, monkeypatch
):
    """The live-evidence scenario this task exists for: a stored refresh
    token that Bambu now 401s (worker log: `POST .../refreshtoken -> 401`).
    `get_access_token_sync` must both re-raise (kind="expired") AND persist
    `refresh_failed_at` so `GET /settings/bambu` can report it afterwards --
    not just log-and-lose the fact in this one request."""
    from app.tasks.base import sync_session

    settings = get_settings()
    await bambu_auth.set_bambu_auth(
        db_session, settings, account="a@b.com", region="global", refresh_token="RT-dead"
    )

    def fake_refresh(refresh_token: str, region: str) -> bambu_auth.BambuAccessToken:
        raise bambu_auth.BambuAuthError(
            "Bambu refresh token is invalid or expired -- reconnect the Bambu account in Settings.",
            kind="expired",
        )

    monkeypatch.setattr(bambu_auth, "refresh", fake_refresh)

    with sync_session() as s, pytest.raises(bambu_auth.BambuAuthError) as exc_info:
        bambu_auth.get_access_token_sync(s, settings)
    assert exc_info.value.kind == "expired"

    row = await db_session.get(Setting, bambu_auth.SETTINGS_KEY)
    await db_session.refresh(row)  # sync-session write -- refresh past the identity map
    assert row.value["refresh_failed_at"]
    # No token value leaks into the stamped marker or the raised message.
    assert "RT-dead" not in str(exc_info.value)
    assert "RT-dead" not in row.value["refresh_failed_at"]

    state = await bambu_auth.get_bambu_auth(db_session, settings)
    assert state.refresh_failed_at


async def test_get_access_token_sync_does_not_stamp_a_marker_a_concurrent_rotation_already_won(
    db_session, monkeypatch
):
    """M1 (post-review fix): two workers race to refresh the same expiring
    `RT-old`. Worker A wins first, rotates in a fresh, valid `RT-new` (which
    also clears any marker). Worker B is still mid-flight against the now-
    superseded `RT-old` and gets rejected -- but by the time it goes to
    stamp `refresh_failed_at`, the row already holds `RT-new`. The
    compare-and-set in `mark_refresh_failed_sync` must skip the stamp rather
    than mark an account that's actually healthy as `needs_reconnect`."""
    from app.tasks.base import sync_session

    settings = get_settings()
    await bambu_auth.set_bambu_auth(
        db_session, settings, account="a@b.com", region="global", refresh_token="RT-old"
    )

    def fake_refresh(refresh_token: str, region: str) -> bambu_auth.BambuAccessToken:
        assert refresh_token == "RT-old"
        # Simulate worker A's concurrent, successful rotation landing on the
        # row (a SEPARATE sync session/connection, same as a different
        # worker process) before this call's rejection gets a chance to
        # stamp it.
        with sync_session() as other:
            bambu_auth.set_bambu_auth_sync(
                other, settings, account="a@b.com", region="global", refresh_token="RT-new"
            )
        raise bambu_auth.BambuAuthError(
            "Bambu refresh token is invalid or expired -- reconnect the Bambu account in Settings.",
            kind="expired",
        )

    monkeypatch.setattr(bambu_auth, "refresh", fake_refresh)

    with sync_session() as s, pytest.raises(bambu_auth.BambuAuthError) as exc_info:
        bambu_auth.get_access_token_sync(s, settings)
    assert exc_info.value.kind == "expired"

    row = await db_session.get(Setting, bambu_auth.SETTINGS_KEY)
    await db_session.refresh(row)  # sync-session write -- refresh past the identity map
    assert "refresh_failed_at" not in row.value
    assert decrypt_secret(settings, row.value["refresh_token"]) == "RT-new"


async def test_get_access_token_sync_clears_a_stale_marker_on_the_next_success_without_rotation(
    db_session, monkeypatch
):
    """Covers the ONE persistence path a rotated-refresh-token write doesn't
    already handle for free: a refresh that succeeds WITHOUT rotating the
    refresh token must still clear a `refresh_failed_at` left over from an
    earlier failed attempt against that same still-valid token (e.g. a
    transient 401) -- otherwise `needs_reconnect` would stay stuck `true`
    forever even though the account is working again."""
    from app.tasks.base import sync_session

    settings = get_settings()
    await bambu_auth.set_bambu_auth(
        db_session, settings, account="a@b.com", region="global", refresh_token="RT-seed"
    )
    await bambu_auth.mark_refresh_failed(db_session, settings, "RT-seed")

    def fake_refresh(refresh_token: str, region: str) -> bambu_auth.BambuAccessToken:
        return bambu_auth.BambuAccessToken(
            access_token="AT-1", refresh_token=refresh_token, expires_at=time.time() + 3600
        )

    monkeypatch.setattr(bambu_auth, "refresh", fake_refresh)

    with sync_session() as s:
        token = bambu_auth.get_access_token_sync(s, settings)
    assert token == "AT-1"

    state = await bambu_auth.get_bambu_auth(db_session, settings)
    assert state.refresh_failed_at is None


async def test_get_access_token_sync_rotated_write_also_clears_a_stale_marker(
    db_session, monkeypatch
):
    from app.tasks.base import sync_session

    settings = get_settings()
    await bambu_auth.set_bambu_auth(
        db_session, settings, account="a@b.com", region="global", refresh_token="RT-old"
    )
    await bambu_auth.mark_refresh_failed(db_session, settings, "RT-old")

    def fake_refresh(refresh_token: str, region: str) -> bambu_auth.BambuAccessToken:
        return bambu_auth.BambuAccessToken(
            access_token="AT-1", refresh_token="RT-rotated", expires_at=time.time() + 3600
        )

    monkeypatch.setattr(bambu_auth, "refresh", fake_refresh)

    with sync_session() as s:
        bambu_auth.get_access_token_sync(s, settings)

    state = await bambu_auth.get_bambu_auth(db_session, settings)
    assert state.refresh_failed_at is None
    assert state.refresh_token == "RT-rotated"


# ---------------------------------------------------------------------------
# get_access_token_sync -- prefer the stored login access token (the fix
# this branch exists for: Bambu's refresh endpoint rejects even fresh
# refresh tokens, live-verified 2026-07-12, so `refresh()` must not be
# depended on for every first per-process use any more).
# ---------------------------------------------------------------------------


async def test_get_access_token_sync_returns_stored_access_token_without_calling_refresh(
    db_session, monkeypatch
):
    """Headline regression: a valid stored access token must be served
    straight off the settings row -- NEVER touching `refresh()` (Bambu's
    refresh endpoint) at all."""
    from app.tasks.base import sync_session

    settings = get_settings()
    await bambu_auth.set_bambu_auth(
        db_session,
        settings,
        account="a@b.com",
        region="global",
        refresh_token="RT-1",
        access_token="AT-stored",
        access_expires_at=time.time() + 3600,
    )

    def fake_refresh(refresh_token: str, region: str) -> bambu_auth.BambuAccessToken:
        raise AssertionError("refresh() must not be called when a stored access token is valid")

    monkeypatch.setattr(bambu_auth, "refresh", fake_refresh)

    with sync_session() as s:
        token = bambu_auth.get_access_token_sync(s, settings)
    assert token == "AT-stored"


async def test_get_access_token_sync_refreshes_once_the_stored_access_token_nears_expiry(
    db_session, monkeypatch
):
    """Once the stored access token is within the early-refresh margin of
    its estimated expiry, `refresh()` IS consulted (and a successful result
    is preferred over the near-expiry stored token)."""
    from app.tasks.base import sync_session

    settings = get_settings()
    await bambu_auth.set_bambu_auth(
        db_session,
        settings,
        account="a@b.com",
        region="global",
        refresh_token="RT-1",
        access_token="AT-near-expiry",
        access_expires_at=time.time() - 1,  # already past its estimated expiry
    )

    def fake_refresh(refresh_token: str, region: str) -> bambu_auth.BambuAccessToken:
        assert refresh_token == "RT-1"
        return bambu_auth.BambuAccessToken(
            access_token="AT-fresh", refresh_token="RT-1", expires_at=time.time() + 3600
        )

    monkeypatch.setattr(bambu_auth, "refresh", fake_refresh)

    with sync_session() as s:
        token = bambu_auth.get_access_token_sync(s, settings)
    assert token == "AT-fresh"


async def test_get_access_token_sync_falls_back_to_still_valid_access_token_when_refresh_fails(
    db_session, monkeypatch
):
    """The early-refresh-margin edge case: the stored access token is within
    the margin (so step 2 doesn't short-circuit) but not yet ACTUALLY
    expired. If the resulting `refresh()` attempt fails (kind="expired" --
    Bambu's refresh endpoint is unreliable, see module docstring), the
    still-technically-valid stored access token must be served instead of
    raising, and the `refresh_failed_at` marker must NOT be stamped."""
    from app.tasks.base import sync_session

    settings = get_settings()
    await bambu_auth.set_bambu_auth(
        db_session,
        settings,
        account="a@b.com",
        region="global",
        refresh_token="RT-1",
        access_token="AT-still-good",
        access_expires_at=time.time() + 30,  # inside the 60s margin, not yet expired
    )

    def fake_refresh(refresh_token: str, region: str) -> bambu_auth.BambuAccessToken:
        raise bambu_auth.BambuAuthError(
            "Bambu refresh token is invalid or expired -- reconnect the Bambu account in Settings.",
            kind="expired",
        )

    monkeypatch.setattr(bambu_auth, "refresh", fake_refresh)

    with sync_session() as s:
        token = bambu_auth.get_access_token_sync(s, settings)
    assert token == "AT-still-good"

    row = await db_session.get(Setting, bambu_auth.SETTINGS_KEY)
    await db_session.refresh(row)  # sync-session write -- refresh past the identity map
    assert "refresh_failed_at" not in row.value


async def test_get_access_token_sync_stamps_marker_when_refresh_fails_and_no_access_token_left(
    db_session, monkeypatch
):
    """The other side of the fallback above: once the stored access token
    itself has also genuinely expired, a failed refresh IS a reconnect-
    worthy failure again -- existing kind="expired" + marker-stamped
    behavior must be preserved."""
    from app.tasks.base import sync_session

    settings = get_settings()
    await bambu_auth.set_bambu_auth(
        db_session,
        settings,
        account="a@b.com",
        region="global",
        refresh_token="RT-dead",
        access_token="AT-also-dead",
        access_expires_at=time.time() - 100,  # genuinely expired, no margin needed
    )

    def fake_refresh(refresh_token: str, region: str) -> bambu_auth.BambuAccessToken:
        raise bambu_auth.BambuAuthError(
            "Bambu refresh token is invalid or expired -- reconnect the Bambu account in Settings.",
            kind="expired",
        )

    monkeypatch.setattr(bambu_auth, "refresh", fake_refresh)

    with sync_session() as s, pytest.raises(bambu_auth.BambuAuthError) as exc_info:
        bambu_auth.get_access_token_sync(s, settings)
    assert exc_info.value.kind == "expired"
    assert "RT-dead" not in str(exc_info.value) and "AT-also-dead" not in str(exc_info.value)

    row = await db_session.get(Setting, bambu_auth.SETTINGS_KEY)
    await db_session.refresh(row)
    assert row.value["refresh_failed_at"]


async def test_get_access_token_sync_persists_new_access_token_on_successful_refresh_with_rotation(
    db_session, monkeypatch
):
    from app.tasks.base import sync_session

    settings = get_settings()
    await bambu_auth.set_bambu_auth(
        db_session, settings, account="a@b.com", region="global", refresh_token="RT-old"
    )

    def fake_refresh(refresh_token: str, region: str) -> bambu_auth.BambuAccessToken:
        return bambu_auth.BambuAccessToken(
            access_token="AT-new", refresh_token="RT-new", expires_at=time.time() + 3600
        )

    monkeypatch.setattr(bambu_auth, "refresh", fake_refresh)

    with sync_session() as s:
        bambu_auth.get_access_token_sync(s, settings)

    row = await db_session.get(Setting, bambu_auth.SETTINGS_KEY)
    await db_session.refresh(row)  # sync-session write -- refresh past the identity map
    assert decrypt_secret(settings, row.value["access_token"]) == "AT-new"
    assert row.value["access_expires_at"] > time.time()

    state = await bambu_auth.get_bambu_auth(db_session, settings)
    assert state.access_token == "AT-new"
    assert state.refresh_token == "RT-new"


async def test_get_access_token_sync_persists_new_access_token_on_refresh_without_rotation(
    db_session, monkeypatch
):
    from app.tasks.base import sync_session

    settings = get_settings()
    await bambu_auth.set_bambu_auth(
        db_session, settings, account="a@b.com", region="global", refresh_token="RT-seed"
    )
    await bambu_auth.mark_refresh_failed(db_session, settings, "RT-seed")

    def fake_refresh(refresh_token: str, region: str) -> bambu_auth.BambuAccessToken:
        return bambu_auth.BambuAccessToken(
            access_token="AT-fresh", refresh_token=refresh_token, expires_at=time.time() + 3600
        )

    monkeypatch.setattr(bambu_auth, "refresh", fake_refresh)

    with sync_session() as s:
        token = bambu_auth.get_access_token_sync(s, settings)
    assert token == "AT-fresh"

    row = await db_session.get(Setting, bambu_auth.SETTINGS_KEY)
    await db_session.refresh(row)
    assert decrypt_secret(settings, row.value["access_token"]) == "AT-fresh"
    # Cleared even though the refresh token itself didn't rotate.
    assert "refresh_failed_at" not in row.value
