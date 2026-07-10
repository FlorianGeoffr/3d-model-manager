"""Printables account session (Workstream A task A1; M9 saved-collections
follow-on to M8's `followed_collections` seam). Printables has no OAuth flow
this app can drive itself -- the Prusa PKCE login belongs to Printables' own
OAuth client/`redirect_uri` -- so "connect" here means the user pastes their
browser's ``auth.refresh_token`` cookie value, which we validate against
Printables' own refresh endpoint, then store (encrypted) and keep rotating,
mirroring ``app.services.bambu_auth``'s posture exactly:

**Storage (SECURITY):** only ``username`` + ``user_id`` + the
``refresh_token`` are ever persisted, in the ``settings`` table under key
``"printables_auth"``, the refresh token Fernet-encrypted (``app.crypto``,
the same seam as the Bambu refresh token / M4 printer access code / M6
storage secrets / the Thingiverse import token), with an ``InvalidToken``
legacy-plaintext fallback on read (mirrors ``bambu_auth.py`` even though this
key is new -- cheap insurance against a key file ever being swapped out from
under an existing row). The ACCESS token is never persisted -- it's
short-lived (~2h) and cheap to re-derive from the refresh token via
``refresh()``, so ``get_access_token_sync`` keeps only an in-memory,
per-process cache (``_ACCESS_TOKEN_CACHE``) keyed by the refresh token
currently on file. Neither the access nor refresh token is ever logged,
echoed, or returned by any endpoint.

**Contract confidence -- LIVE-VERIFIED 2026-07-10** against a real Printables
account (not documented-then-guessed, unlike Bambu's shapes):
``POST https://www.printables.com/auth/refresh`` with the refresh token
carried ONLY as the ``auth.refresh_token`` cookie (never in the body, never
as a Bearer header -- all three were tried and rejected) and an empty JSON
body returns a bare ``200 {"ok": true}`` with the actual tokens riding back
as ``Set-Cookie`` headers, NOT the JSON body -- ``_set_cookies`` parses those
by hand rather than trusting httpx's cookie jar, since the cookies carry
``Domain=printables.com; Path=/auth/refresh`` and a jar may drop or rewrite
them. **The refresh token ROTATES on every single call** (new ``jti``, same
``sid``) -- ``get_access_token_sync`` persists the rotated token BEFORE
caching the new access token, so a lost rotation can never strand the
connection. An invalid/expired/absent token live-verified to 401 with
``{"error":"No token provided"}``; that always becomes a clean
``PrintablesAuthError`` asking the user to reconnect, never a crash.
Refresh-token-reuse detection was deliberately NOT probed (destructive), so
its behavior is unknown -- treat any unexpected 401 as "reconnect required",
which is already the correct response either way.
"""

from __future__ import annotations

import base64
import contextlib
import json
import time
from dataclasses import dataclass

import httpx
from cryptography.fernet import InvalidToken
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session as SyncSession

from app.config import Settings
from app.crypto import decrypt_secret, encrypt_secret
from app.models import Setting

SETTINGS_KEY = "printables_auth"

_BASE_URL = "https://www.printables.com"
_UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0 Safari/537.36"
)

# Safety margin subtracted from an estimated access-token expiry so
# `get_access_token_sync` refreshes a little BEFORE Printables would actually
# reject the token (clock skew / in-flight request latency), never after.
# Same constant name/value as bambu_auth.py.
_EXPIRY_SAFETY_MARGIN_S = 60
# Used only when neither the `auth.access_token_exp` cookie nor the access
# token's own (unverified) JWT `exp` claim yields a usable expiry -- a
# conservative floor that forces a fresh refresh soon rather than caching an
# access token for an unknown, possibly-already-elapsed lifetime.
_FALLBACK_ACCESS_TOKEN_TTL_S = 300

# In-memory ONLY (never persisted -- see module docstring), keyed by the
# refresh token currently on file so a credential change (a new connect, or
# Printables rotating the refresh token on use) can never serve a stale
# cached access token for a DIFFERENT refresh token.
_ACCESS_TOKEN_CACHE: dict[str, tuple[str, float]] = {}


class PrintablesAuthError(Exception):
    """A Printables auth call failed in an expected way (invalid/expired
    refresh token, or no account connected at all) -- always a clean,
    user-facing message, never a raw httpx/JSON exception leaking upward."""


@dataclass(frozen=True)
class PrintablesAccessToken:
    """Result of ``refresh()``: a fresh access token, the refresh token to
    use NEXT time (Printables rotates it on EVERY call -- live-verified, see
    module docstring), and a best-effort expiry."""

    access_token: str
    refresh_token: str
    expires_at: float


class PrintablesAuthState(BaseModel):
    """Decrypted at-rest shape. ``refresh_token`` is ``None`` when no
    account is connected."""

    username: str | None = None
    user_id: str | None = None
    refresh_token: str | None = None


def _client() -> httpx.Client:
    """The ONE httpx seam tests monkeypatch (mirrors every importer's
    ``_client``)."""
    return httpx.Client(
        base_url=_BASE_URL,
        timeout=30.0,
        follow_redirects=True,
        headers={
            "User-Agent": _UA,
            "Origin": _BASE_URL,
            "Referer": f"{_BASE_URL}/",
        },
    )


def _set_cookies(r: httpx.Response) -> dict[str, str]:
    """Hand-rolled Set-Cookie parse (see module docstring for why httpx's
    cookie jar isn't trusted here: the cookies carry
    ``Domain=printables.com; Path=/auth/refresh`` and a jar may drop or
    rewrite them)."""
    out: dict[str, str] = {}
    for raw in r.headers.get_list("set-cookie"):
        name, _, rest = raw.partition("=")
        out[name.strip()] = rest.split(";", 1)[0].strip()
    return out


def refresh(refresh_token: str) -> PrintablesAccessToken:
    """Exchange a stored refresh token for a fresh access token. Raises
    ``PrintablesAuthError`` on an invalid/expired/absent refresh token (HTTP
    401, live-verified) -- the caller (``get_access_token_sync``) surfaces
    this as "reconnect your Printables account" rather than crashing."""
    with _client() as c:
        r = c.post(
            "/auth/refresh",
            headers={"Cookie": f"auth.refresh_token={refresh_token}"},
            json={},
        )
    if r.status_code == 401:
        raise PrintablesAuthError(
            "Printables refresh token is invalid or expired -- reconnect the Printables "
            "account in Settings."
        )
    r.raise_for_status()
    cookies = _set_cookies(r)
    access = cookies.get("auth.access_token")
    if not access:
        raise PrintablesAuthError("Printables' refresh response did not include an access token.")
    new_refresh = cookies.get("auth.refresh_token") or refresh_token
    return PrintablesAccessToken(
        access_token=access,
        refresh_token=new_refresh,
        expires_at=_estimate_expiry(cookies, access),
    )


def _decode_jwt_exp(token: str) -> float | None:
    """Best-effort, UNVERIFIED (no signature check -- we trust the issuer,
    Printables, not the bearer) read of a JWT's ``exp`` claim, used only as
    an expiry ESTIMATE for cache freshness. Never raises: any malformed
    token just falls through to the fixed fallback TTL in
    ``_estimate_expiry``."""
    try:
        _, payload_b64, _ = token.split(".")
        padding = "=" * (-len(payload_b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64 + padding))
        exp = payload.get("exp")
        return float(exp) if exp is not None else None
    except Exception:  # noqa: BLE001 -- purely best-effort; any failure mode falls back
        return None


def _estimate_expiry(cookies: dict[str, str], access_token: str) -> float:
    raw_exp = cookies.get("auth.access_token_exp")
    if raw_exp:
        with contextlib.suppress(ValueError, TypeError):
            return float(raw_exp) - _EXPIRY_SAFETY_MARGIN_S
        # malformed `_exp` cookie -- fall through rather than raise
    exp_claim = _decode_jwt_exp(access_token)
    if exp_claim is not None:
        return exp_claim - _EXPIRY_SAFETY_MARGIN_S
    return time.time() + _FALLBACK_ACCESS_TOKEN_TTL_S


def _decrypt_state(settings: Settings, value: dict | None) -> PrintablesAuthState:
    if not value:
        return PrintablesAuthState()
    raw = value.get("refresh_token")
    if not raw:
        return PrintablesAuthState(username=value.get("username"), user_id=value.get("user_id"))
    try:
        token = decrypt_secret(settings, raw)
    except InvalidToken:
        token = raw  # defensive legacy-plaintext fallback, mirrors bambu_auth.py
    return PrintablesAuthState(
        username=value.get("username"), user_id=value.get("user_id"), refresh_token=token
    )


async def get_printables_auth(db: AsyncSession, settings: Settings) -> PrintablesAuthState:
    row = await db.get(Setting, SETTINGS_KEY)
    return _decrypt_state(settings, row.value if row else None)


def get_printables_auth_sync(session: SyncSession, settings: Settings) -> PrintablesAuthState:
    row = session.get(Setting, SETTINGS_KEY)
    return _decrypt_state(settings, row.value if row else None)


async def set_printables_auth(
    db: AsyncSession,
    settings: Settings,
    *,
    username: str | None,
    user_id: str | None,
    refresh_token: str,
) -> None:
    value = {
        "username": username,
        "user_id": user_id,
        "refresh_token": encrypt_secret(settings, refresh_token),
    }
    row = await db.get(Setting, SETTINGS_KEY)
    if row is None:
        db.add(Setting(key=SETTINGS_KEY, value=value))
    else:
        row.value = value
    await db.commit()
    _ACCESS_TOKEN_CACHE.clear()  # credential changed -- any cached access token is stale


def set_printables_auth_sync(
    session: SyncSession,
    settings: Settings,
    *,
    username: str | None,
    user_id: str | None,
    refresh_token: str,
) -> None:
    value = {
        "username": username,
        "user_id": user_id,
        "refresh_token": encrypt_secret(settings, refresh_token),
    }
    row = session.get(Setting, SETTINGS_KEY)
    if row is None:
        session.add(Setting(key=SETTINGS_KEY, value=value))
    else:
        row.value = value
    session.commit()
    _ACCESS_TOKEN_CACHE.clear()


async def clear_printables_auth(db: AsyncSession, settings: Settings) -> None:
    row = await db.get(Setting, SETTINGS_KEY)
    if row is not None:
        await db.delete(row)
        await db.commit()
    _ACCESS_TOKEN_CACHE.clear()


def get_access_token_sync(session: SyncSession, settings: Settings) -> str:
    """A currently-valid Printables access token for worker use (the A4 list/
    items importer calls). An in-memory cache (module-level, NOT persisted --
    see module docstring) keyed by the stored refresh token avoids re-hitting
    Printables' refresh endpoint for every call within a sync run. Raises
    ``PrintablesAuthError`` with a clear "not connected" message when no
    account is connected, or whatever ``refresh()`` raises when the stored
    refresh token itself is no longer valid.
    """
    state = get_printables_auth_sync(session, settings)
    if not state.refresh_token:
        raise PrintablesAuthError("no Printables account is connected -- connect one in Settings.")
    cached = _ACCESS_TOKEN_CACHE.get(state.refresh_token)
    if cached is not None and cached[1] > time.time():
        return cached[0]
    token = refresh(state.refresh_token)
    if token.refresh_token != state.refresh_token:
        # Printables rotates the refresh token on EVERY call (live-verified)
        # -- persist the new one BEFORE caching the access token below
        # (set_printables_auth_sync clears the whole cache as part of a
        # credential change), so the entry we add next isn't immediately
        # wiped out by that same clear.
        set_printables_auth_sync(
            session,
            settings,
            username=state.username,
            user_id=state.user_id,
            refresh_token=token.refresh_token,
        )
    _ACCESS_TOKEN_CACHE[token.refresh_token] = (token.access_token, token.expires_at)
    return token.access_token
