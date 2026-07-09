"""``GET/POST/DELETE /api/settings/bambu*`` (Workstream B task B2). The real
Bambu network calls (``bambu_auth.login``/``verify_code``) are monkeypatched
at the service-module level -- this file only exercises the API surface
(status/login/verify/disconnect wiring, encryption at rest, and the
never-return-a-token contract), mirroring ``tests/test_import_tokens_api.py``.
"""

from __future__ import annotations

import httpx
import pytest

from app.config import get_settings
from app.crypto import decrypt_secret
from app.models import Setting
from app.services import bambu_auth

pytestmark = pytest.mark.usefixtures("data_dir")


async def test_get_status_when_not_connected(authenticated_client: httpx.AsyncClient) -> None:
    r = await authenticated_client.get("/api/settings/bambu")
    assert r.status_code == 200
    assert r.json() == {"connected": False, "account": None, "region": "global"}


async def test_login_success_connects_and_never_returns_a_token(
    authenticated_client: httpx.AsyncClient, db_session, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fake_login(account: str, password: str, region: str) -> bambu_auth.BambuLoginResult:
        assert account == "a@b.com" and password == "hunter2" and region == "global"
        return bambu_auth.BambuLoginResult(
            status="connected", access_token="AT-secret", refresh_token="RT-secret"
        )

    monkeypatch.setattr(bambu_auth, "login", fake_login)

    r = await authenticated_client.post(
        "/api/settings/bambu/login",
        json={"account": "a@b.com", "password": "hunter2", "region": "global"},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {
        "status": "connected",
        "account": "a@b.com",
        "region": "global",
        "mfa_context": None,
    }
    assert "AT-secret" not in r.text and "RT-secret" not in r.text

    status_response = await authenticated_client.get("/api/settings/bambu")
    assert status_response.json() == {"connected": True, "account": "a@b.com", "region": "global"}

    # M6-posture parity: the refresh token is Fernet-encrypted at rest.
    row = await db_session.get(Setting, bambu_auth.SETTINGS_KEY)
    assert row.value["refresh_token"] != "RT-secret"
    assert decrypt_secret(get_settings(), row.value["refresh_token"]) == "RT-secret"


async def test_login_mfa_required_does_not_connect(
    authenticated_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fake_login(account: str, password: str, region: str) -> bambu_auth.BambuLoginResult:
        return bambu_auth.BambuLoginResult(
            status="mfa_required", mfa_context={"loginType": "verifyCode", "tfaKey": "ctx-1"}
        )

    monkeypatch.setattr(bambu_auth, "login", fake_login)

    r = await authenticated_client.post(
        "/api/settings/bambu/login",
        json={"account": "a@b.com", "password": "hunter2", "region": "global"},
    )
    assert r.status_code == 200, r.text
    assert r.json() == {
        "status": "mfa_required",
        "account": "a@b.com",
        "region": "global",
        "mfa_context": {"loginType": "verifyCode", "tfaKey": "ctx-1"},
    }

    status_response = await authenticated_client.get("/api/settings/bambu")
    assert status_response.json()["connected"] is False


async def test_login_bad_credentials_returns_400_and_leaks_nothing(
    authenticated_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fake_login(account: str, password: str, region: str) -> bambu_auth.BambuLoginResult:
        raise bambu_auth.BambuAuthError("Incorrect account or password.")

    monkeypatch.setattr(bambu_auth, "login", fake_login)

    r = await authenticated_client.post(
        "/api/settings/bambu/login",
        json={"account": "a@b.com", "password": "wrong", "region": "global"},
    )
    assert r.status_code == 400
    assert "Incorrect account or password" in r.text
    assert "wrong" not in r.text


async def test_verify_completes_mfa_and_connects(
    authenticated_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fake_verify_code(
        account: str, code: str, region: str, context: dict
    ) -> bambu_auth.BambuLoginResult:
        assert account == "a@b.com" and code == "000000" and region == "global"
        assert context == {"tfaKey": "ctx-1"}
        return bambu_auth.BambuLoginResult(
            status="connected", access_token="AT-2", refresh_token="RT-2"
        )

    monkeypatch.setattr(bambu_auth, "verify_code", fake_verify_code)

    r = await authenticated_client.post(
        "/api/settings/bambu/verify",
        json={
            "account": "a@b.com",
            "code": "000000",
            "region": "global",
            "mfa_context": {"tfaKey": "ctx-1"},
        },
    )
    assert r.status_code == 200, r.text
    assert r.json() == {
        "status": "connected",
        "account": "a@b.com",
        "region": "global",
        "mfa_context": None,
    }
    assert "AT-2" not in r.text and "RT-2" not in r.text

    status_response = await authenticated_client.get("/api/settings/bambu")
    assert status_response.json() == {"connected": True, "account": "a@b.com", "region": "global"}


async def test_verify_rejected_code_returns_400(
    authenticated_client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    def fake_verify_code(
        account: str, code: str, region: str, context: dict
    ) -> bambu_auth.BambuLoginResult:
        raise bambu_auth.BambuAuthError("Bambu did not accept the verification code.")

    monkeypatch.setattr(bambu_auth, "verify_code", fake_verify_code)

    r = await authenticated_client.post(
        "/api/settings/bambu/verify",
        json={"account": "a@b.com", "code": "999999", "region": "global", "mfa_context": {}},
    )
    assert r.status_code == 400
    assert "verification code" in r.text


async def test_disconnect_clears_stored_state(
    authenticated_client: httpx.AsyncClient, db_session
) -> None:
    settings = get_settings()
    # Seeded via a throwaway session (not `db_session`) so the identity-map
    # staleness this module's other tests avoid via `.refresh(...)` (see
    # test_bambu_auth.py's docstring) can't mask a real "still connected"
    # bug here: `db_session` below must do a genuinely fresh lookup.
    from app.db import get_sessionmaker

    async with get_sessionmaker()() as seed_session:
        await bambu_auth.set_bambu_auth(
            seed_session, settings, account="a@b.com", region="global", refresh_token="RT-3"
        )

    r = await authenticated_client.delete("/api/settings/bambu")
    assert r.status_code == 204

    status_response = await authenticated_client.get("/api/settings/bambu")
    assert status_response.json() == {"connected": False, "account": None, "region": "global"}
    assert await db_session.get(Setting, bambu_auth.SETTINGS_KEY) is None
