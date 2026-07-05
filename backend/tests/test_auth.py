"""Login/logout/me + session enforcement (SPEC requirement 1, "API surface"
auth rows). Uses the real Postgres testcontainer (``db_session``) to seed
users/sessions directly and the ASGI ``client`` fixture to drive the HTTP
surface -- both fixtures share the one testcontainer DB (see conftest.py).
"""

import http.cookies
import uuid
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models import Session, User
from app.security import hash_password

USERNAME = "admin"
PASSWORD = "correct horse battery staple"


@pytest.fixture(autouse=True)
def _clear_settings_cache():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
async def admin_user(db_session: AsyncSession) -> User:
    user = User(username=USERNAME, password_hash=hash_password(PASSWORD))
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    return user


def _set_cookie_header(response: httpx.Response) -> str:
    header = response.headers.get("set-cookie")
    assert header is not None, "expected a Set-Cookie header"
    return header


# ---------------------------------------------------------------------------
# login
# ---------------------------------------------------------------------------


async def test_login_unknown_username_rejected(client: httpx.AsyncClient) -> None:
    response = await client.post(
        "/api/auth/login", json={"username": "nobody", "password": "whatever"}
    )

    assert response.status_code == 401
    assert "set-cookie" not in response.headers


async def test_login_wrong_password_gives_same_response_as_unknown_username(
    client: httpx.AsyncClient, admin_user: User
) -> None:
    bad_username = await client.post(
        "/api/auth/login", json={"username": "nobody", "password": "whatever"}
    )
    bad_password = await client.post(
        "/api/auth/login", json={"username": USERNAME, "password": "wrong-password"}
    )

    assert bad_username.status_code == bad_password.status_code == 401
    assert bad_username.json() == bad_password.json()


async def test_login_correct_credentials_returns_204_and_creates_session(
    client: httpx.AsyncClient, admin_user: User, db_session: AsyncSession
) -> None:
    before = datetime.now(UTC)

    response = await client.post(
        "/api/auth/login", json={"username": USERNAME, "password": PASSWORD}
    )

    assert response.status_code == 204
    assert response.content == b""

    header = _set_cookie_header(response)
    cookie: http.cookies.BaseCookie = http.cookies.SimpleCookie()
    cookie.load(header)
    morsel = cookie["tdmm_session"]
    token = uuid.UUID(morsel.value)  # raises if not a valid session token

    session = await db_session.get(Session, token)
    assert session is not None
    assert session.user_id == admin_user.id
    expected_expiry = before + timedelta(days=30)
    assert abs((session.expires_at - expected_expiry).total_seconds()) < 5


async def test_login_cookie_flags_default_not_secure(
    client: httpx.AsyncClient, admin_user: User
) -> None:
    response = await client.post(
        "/api/auth/login", json={"username": USERNAME, "password": PASSWORD}
    )

    header = _set_cookie_header(response).lower()
    assert "httponly" in header
    assert "samesite=lax" in header
    assert "secure" not in header


async def test_login_cookie_is_secure_when_configured(
    client: httpx.AsyncClient,
    admin_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TDMM_COOKIE_SECURE", "true")
    get_settings.cache_clear()

    response = await client.post(
        "/api/auth/login", json={"username": USERNAME, "password": PASSWORD}
    )

    header = _set_cookie_header(response).lower()
    assert "secure" in header
    assert "httponly" in header
    assert "samesite=lax" in header


# ---------------------------------------------------------------------------
# protected route enforcement (/api/auth/me stands in for "any protected
# route" -- Task 3 doesn't add any business routers yet)
# ---------------------------------------------------------------------------


async def test_me_without_cookie_is_401_with_www_authenticate(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/auth/me")

    assert response.status_code == 401
    assert response.headers.get("www-authenticate") == "Cookie"


async def test_me_with_garbage_cookie_is_401(client: httpx.AsyncClient) -> None:
    client.cookies.set("tdmm_session", "not-a-uuid")
    response = await client.get("/api/auth/me")

    assert response.status_code == 401


async def test_me_with_valid_session_returns_username(
    client: httpx.AsyncClient, admin_user: User
) -> None:
    await client.post("/api/auth/login", json={"username": USERNAME, "password": PASSWORD})

    response = await client.get("/api/auth/me")

    assert response.status_code == 200
    assert response.json() == {"username": USERNAME}


async def test_expired_session_is_rejected(
    client: httpx.AsyncClient, admin_user: User, db_session: AsyncSession
) -> None:
    expired = Session(
        user_id=admin_user.id,
        expires_at=datetime.now(UTC) - timedelta(seconds=1),
    )
    db_session.add(expired)
    await db_session.commit()

    client.cookies.set("tdmm_session", str(expired.id))
    response = await client.get("/api/auth/me")

    assert response.status_code == 401


# ---------------------------------------------------------------------------
# logout
# ---------------------------------------------------------------------------


async def test_logout_deletes_session_and_clears_cookie(
    client: httpx.AsyncClient, admin_user: User, db_session: AsyncSession
) -> None:
    login = await client.post("/api/auth/login", json={"username": USERNAME, "password": PASSWORD})
    cookie = http.cookies.SimpleCookie()
    cookie.load(_set_cookie_header(login))
    token = uuid.UUID(cookie["tdmm_session"].value)

    response = await client.post("/api/auth/logout")

    assert response.status_code == 204
    clear_header = _set_cookie_header(response).lower()
    assert "max-age=0" in clear_header

    assert await db_session.get(Session, token) is None

    followup = await client.get("/api/auth/me")
    assert followup.status_code == 401


# ---------------------------------------------------------------------------
# last_seen_at throttling
# ---------------------------------------------------------------------------


async def test_last_seen_at_is_not_updated_within_throttle_window(
    client: httpx.AsyncClient, admin_user: User, db_session: AsyncSession
) -> None:
    now = datetime.now(UTC)
    session = Session(user_id=admin_user.id, expires_at=now + timedelta(days=30), last_seen_at=now)
    db_session.add(session)
    await db_session.commit()

    client.cookies.set("tdmm_session", str(session.id))
    response = await client.get("/api/auth/me")
    assert response.status_code == 200

    await db_session.refresh(session)
    assert abs((session.last_seen_at - now).total_seconds()) < 5


async def test_last_seen_at_updates_after_throttle_window(
    client: httpx.AsyncClient, admin_user: User, db_session: AsyncSession
) -> None:
    stale = datetime.now(UTC) - timedelta(minutes=5)
    session = Session(
        user_id=admin_user.id, expires_at=datetime.now(UTC) + timedelta(days=30), last_seen_at=stale
    )
    db_session.add(session)
    await db_session.commit()

    client.cookies.set("tdmm_session", str(session.id))
    response = await client.get("/api/auth/me")
    assert response.status_code == 200

    await db_session.refresh(session)
    assert session.last_seen_at > stale
    assert (datetime.now(UTC) - session.last_seen_at).total_seconds() < 5
