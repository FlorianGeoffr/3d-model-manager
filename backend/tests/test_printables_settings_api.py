"""``GET/POST/DELETE /api/settings/printables*`` (Workstream A task A1). The
real Printables network calls (``printables_auth.refresh``/
``app.api.settings.fetch_identity``) are monkeypatched at the module level --
this file only exercises the API surface (status/connect/disconnect wiring,
encryption at rest, and the never-return-a-token contract), mirroring
``tests/test_bambu_settings_api.py``.
"""

from __future__ import annotations

import time

import httpx
import pytest

from app.api import settings as settings_api
from app.config import get_settings
from app.crypto import decrypt_secret
from app.models import Setting
from app.services import printables_auth

pytestmark = pytest.mark.usefixtures("data_dir")


def _fake_token(
    *, access_token: str = "AT-secret", refresh_token: str = "RT-rotated"
) -> printables_auth.PrintablesAccessToken:
    return printables_auth.PrintablesAccessToken(
        access_token=access_token, refresh_token=refresh_token, expires_at=time.time() + 3600
    )


async def test_get_status_when_not_connected(authenticated_client: httpx.AsyncClient) -> None:
    r = await authenticated_client.get("/api/settings/printables")
    assert r.status_code == 200
    assert r.json() == {"connected": False, "username": None, "user_id": None}


async def test_connect_success_stores_rotated_token_and_never_returns_one(
    authenticated_client: httpx.AsyncClient, db_session, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fake_refresh(refresh_token: str) -> printables_auth.PrintablesAccessToken:
        assert refresh_token == "RT-pasted"
        return _fake_token(access_token="AT-secret", refresh_token="RT-rotated")

    def fake_fetch_identity(access_token: str) -> tuple[str | None, str | None]:
        assert access_token == "AT-secret"
        return ("5092991", "makerfoo")

    monkeypatch.setattr(printables_auth, "refresh", fake_refresh)
    monkeypatch.setattr(settings_api, "fetch_identity", fake_fetch_identity)

    r = await authenticated_client.post(
        "/api/settings/printables/connect", json={"refresh_token": "RT-pasted"}
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"connected": True, "username": "makerfoo", "user_id": "5092991"}
    assert "AT-secret" not in r.text and "RT-rotated" not in r.text and "RT-pasted" not in r.text

    status_response = await authenticated_client.get("/api/settings/printables")
    assert status_response.json() == {
        "connected": True,
        "username": "makerfoo",
        "user_id": "5092991",
    }
    assert "AT-secret" not in status_response.text and "RT-rotated" not in status_response.text

    # M6-posture parity: the STORED token is the rotated one, not the
    # plaintext the operator pasted, and it's Fernet-encrypted at rest.
    row = await db_session.get(Setting, printables_auth.SETTINGS_KEY)
    assert row.value["refresh_token"] != "RT-rotated"
    assert row.value["refresh_token"] != "RT-pasted"
    assert decrypt_secret(get_settings(), row.value["refresh_token"]) == "RT-rotated"


async def test_connect_with_bad_token_returns_400(
    authenticated_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fake_refresh(refresh_token: str) -> printables_auth.PrintablesAccessToken:
        raise printables_auth.PrintablesAuthError(
            "Printables refresh token is invalid or expired -- reconnect the Printables "
            "account in Settings."
        )

    monkeypatch.setattr(printables_auth, "refresh", fake_refresh)

    r = await authenticated_client.post(
        "/api/settings/printables/connect", json={"refresh_token": "RT-bad"}
    )
    assert r.status_code == 400
    assert "invalid or expired" in r.text
    assert "RT-bad" not in r.text

    status_response = await authenticated_client.get("/api/settings/printables")
    assert status_response.json()["connected"] is False


async def test_connect_rejects_blank_token_at_schema_boundary(
    authenticated_client: httpx.AsyncClient,
) -> None:
    r = await authenticated_client.post(
        "/api/settings/printables/connect", json={"refresh_token": ""}
    )
    assert r.status_code == 422


async def test_connect_still_succeeds_when_fetch_identity_raises(
    authenticated_client: httpx.AsyncClient, db_session, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The refresh token is proven good by `refresh()` succeeding -- a
    # cosmetic identity-lookup failure must not fail the connect.
    def fake_refresh(refresh_token: str) -> printables_auth.PrintablesAccessToken:
        return _fake_token(access_token="AT-secret", refresh_token="RT-rotated")

    def fake_fetch_identity(access_token: str) -> tuple[str | None, str | None]:
        raise RuntimeError("Printables GraphQL error: boom")

    monkeypatch.setattr(printables_auth, "refresh", fake_refresh)
    monkeypatch.setattr(settings_api, "fetch_identity", fake_fetch_identity)

    r = await authenticated_client.post(
        "/api/settings/printables/connect", json={"refresh_token": "RT-pasted"}
    )
    assert r.status_code == 200, r.text
    assert r.json() == {"connected": True, "username": None, "user_id": None}

    row = await db_session.get(Setting, printables_auth.SETTINGS_KEY)
    assert decrypt_secret(get_settings(), row.value["refresh_token"]) == "RT-rotated"


async def test_disconnect_clears_stored_state(
    authenticated_client: httpx.AsyncClient, db_session
) -> None:
    settings = get_settings()
    # Seeded via a throwaway session (not `db_session`) so the identity-map
    # staleness this module's other tests avoid via `.refresh(...)` (see
    # test_printables_auth.py's docstring) can't mask a real "still
    # connected" bug here: `db_session` below must do a genuinely fresh
    # lookup.
    from app.db import get_sessionmaker

    async with get_sessionmaker()() as seed_session:
        await printables_auth.set_printables_auth(
            seed_session, settings, username="makerfoo", user_id="5092991", refresh_token="RT-3"
        )

    r = await authenticated_client.delete("/api/settings/printables")
    assert r.status_code == 204

    status_response = await authenticated_client.get("/api/settings/printables")
    assert status_response.json() == {"connected": False, "username": None, "user_id": None}
    assert await db_session.get(Setting, printables_auth.SETTINGS_KEY) is None
