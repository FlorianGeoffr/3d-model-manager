"""Bambu Lab account auth (Workstream B task B2; SPEC/full-design-doc line
230 "Connect Bambu account" flow). MakerWorld's model-FILE downloads are
gated behind a Bambu Lab cloud account -- this module owns login/MFA/refresh
against ``api.bambulab.com`` (global) / ``api.bambulab.cn`` (China), and the
at-rest storage of the resulting credential, mirroring
``app.services.import_tokens``'s posture exactly:

**Storage (SECURITY):** only ``account`` + ``region`` + the ``refresh_token``
are ever persisted, in the ``settings`` table under key ``"bambu_auth"``, the
refresh token Fernet-encrypted (``app.crypto``, the same seam as the M4
printer access code / M6 storage secrets / the Thingiverse import token),
with an ``InvalidToken`` legacy-plaintext fallback on read (mirrors
``import_tokens.py`` even though this key is new -- cheap insurance against a
key file ever being swapped out from under an existing row). The PASSWORD is
used only transiently inside ``login()`` to make the one login HTTP call and
is never stored, logged, or returned. The ACCESS token is never persisted
either -- it's short-lived (see ``_estimate_expiry``) and cheap to
re-derive from the refresh token via ``refresh()``, so ``get_access_token_
sync`` keeps only an in-memory, per-process cache (``_ACCESS_TOKEN_CACHE``)
keyed by the refresh token currently on file. Neither the access nor
refresh token is ever logged.

**Contract confidence (BE HONEST about this at acceptance):**
- Login (``POST /user-service/user/login``) and its bad-credentials shape
  (HTTP 400 ``{"code":1,"error":"Incorrect account or password."}``) were
  LIVE-VERIFIED (grounding probe). The SUCCESS shape (direct
  ``accessToken``/``refreshToken``) and the MFA-challenge shape (some
  ``loginType``/continuation-token payload signaling an emailed verification
  code is needed, per SPEC full-design line 230's ``loginType:"verifyCode"``)
  are DOCUMENTED, NOT LIVE-CAPTURED -- no real Bambu account was available to
  grounding. ``_parse_login_response`` therefore parses tolerantly (several
  candidate field names) rather than asserting one exact shape, and treats
  "no recognizable token pair in an HTTP-200 body" as "MFA required",
  carrying the ENTIRE response body through as the opaque continuation
  context for ``verify_code`` rather than guessing which subset of fields
  matters. **This must be verified against one real login before being
  trusted in production** -- if the real shape differs, only
  ``_parse_login_response`` should need adjusting.
- Refresh (``POST /user-service/user/refreshtoken``) was LIVE-VERIFIED to
  EXIST and to 401 a fake token (grounding probe); its SUCCESS response shape
  is likewise documented-not-captured, so ``refresh()`` parses tolerantly
  too. The full design doc separately notes Bambu's refresh endpoint has
  historically been unreliable ("refresh endpoint is broken -> re-login UX
  with expiry banner") -- ``get_access_token_sync`` surfaces a refresh
  failure as a ``kind="expired"`` ``BambuAuthError`` so a caller can prompt
  reconnection rather than crash, AND persists a non-secret
  ``refresh_failed_at`` marker on the stored row (``mark_refresh_failed``/
  ``_sync``, cleared by ``clear_refresh_failed``/``_sync`` or any fresh
  ``set_bambu_auth``/``_sync`` write) so ``GET /settings/bambu`` can report
  ``needs_reconnect`` -- the actual expiry-banner UX this module's contract
  note above always promised.
"""

from __future__ import annotations

import base64
import contextlib
import json
import time
from dataclasses import dataclass
from datetime import UTC, datetime

import httpx
from cryptography.fernet import InvalidToken
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session as SyncSession

from app.config import Settings
from app.crypto import decrypt_secret, encrypt_secret
from app.models import Setting

SETTINGS_KEY = "bambu_auth"

_BASE_URLS = {
    "global": "https://api.bambulab.com/v1",
    "china": "https://api.bambulab.cn/v1",
}
_UA = "3d-model-manager/1.0 (+https://github.com/metril/3d-model-manager)"

# Safety margin subtracted from an estimated access-token expiry so
# `get_access_token_sync` refreshes a little BEFORE Bambu would actually
# reject the token (clock skew / in-flight request latency), never after.
_EXPIRY_SAFETY_MARGIN_S = 60
# Used only when neither the login/refresh response body nor the access
# token's own (unverified) JWT `exp` claim yields a usable expiry -- a
# conservative floor that forces a fresh refresh soon rather than caching an
# access token for an unknown, possibly-already-elapsed lifetime.
_FALLBACK_ACCESS_TOKEN_TTL_S = 300

# In-memory ONLY (never persisted -- see module docstring), keyed by the
# refresh token currently on file so a credential change (new login, or
# Bambu rotating the refresh token on use) can never serve a stale cached
# access token for a DIFFERENT refresh token.
_ACCESS_TOKEN_CACHE: dict[str, tuple[str, float]] = {}


class BambuAuthError(Exception):
    """A Bambu auth call failed in an expected way (bad credentials, bad/
    expired verification code, invalid/expired refresh token, or no account
    connected at all) -- always a clean, user-facing message, never a raw
    httpx/JSON exception leaking upward.

    ``kind`` lets a caller distinguish two flavors WITHOUT string-matching
    the message (Task: expiry-banner UX):
    - ``"not_configured"`` -- no Bambu account is stored at all.
    - ``"expired"`` -- an account IS stored but its refresh token was
      rejected (HTTP 401 from ``POST /user-service/user/refreshtoken``).
    - ``None`` -- any other failure (bad login credentials, bad/expired MFA
      code, a malformed refresh response, ...) that doesn't fit either
      bucket above."""

    def __init__(self, message: str, *, kind: str | None = None) -> None:
        super().__init__(message)
        self.kind = kind


@dataclass(frozen=True)
class BambuLoginResult:
    """Outcome of ``login``/``verify_code``. ``status`` is ``"connected"``
    (tokens present) or ``"mfa_required"`` (a verification code is needed --
    ``mfa_context`` is the ENTIRE raw response body, carried through opaquely
    for the follow-up ``verify_code`` call; see module docstring)."""

    status: str
    access_token: str | None = None
    refresh_token: str | None = None
    mfa_context: dict | None = None


@dataclass(frozen=True)
class BambuAccessToken:
    """Result of ``refresh()``: a fresh access token, the refresh token to
    use NEXT time (Bambu may rotate it on use -- equal to the input when it
    doesn't), and a best-effort expiry (see ``_estimate_expiry``)."""

    access_token: str
    refresh_token: str
    expires_at: float


class BambuAuthState(BaseModel):
    """Decrypted at-rest shape. ``refresh_token`` is ``None`` when no
    account is connected. ``refresh_failed_at`` (UTC ISO string, non-secret)
    is set when the LAST refresh attempt against the currently-stored
    refresh token failed (``mark_refresh_failed``/``_sync``) and cleared by
    a subsequent successful refresh or a fresh login -- ``GET /settings/
    bambu``'s ``needs_reconnect`` is ``bool(refresh_token and
    refresh_failed_at)``."""

    account: str | None = None
    region: str = "global"
    refresh_token: str | None = None
    refresh_failed_at: str | None = None


def base_url_for_region(region: str) -> str:
    """Shared region->host mapping (also used by
    ``app.importers.makerworld`` for the authenticated download call, which
    hits the SAME Bambu account host as auth -- see that module)."""
    return _BASE_URLS.get(region, _BASE_URLS["global"])


def _client(region: str = "global") -> httpx.Client:
    """The ONE httpx seam tests monkeypatch (mirrors every importer's
    ``_client``)."""
    return httpx.Client(
        base_url=base_url_for_region(region),
        timeout=30.0,
        follow_redirects=True,
        headers={"User-Agent": _UA},
    )


def _raise_on_error_status(
    r: httpx.Response, *, unauthorized_message: str, kind: str | None = None
) -> None:
    if r.status_code == 400:
        detail = "Incorrect account or password."
        with contextlib.suppress(ValueError, AttributeError):
            detail = r.json().get("error") or detail
        raise BambuAuthError(detail)
    if r.status_code == 401:
        raise BambuAuthError(unauthorized_message, kind=kind)
    r.raise_for_status()


def _post_login(body: dict, region: str) -> dict:
    with _client(region) as c:
        r = c.post("/user-service/user/login", json=body)
    _raise_on_error_status(
        r, unauthorized_message="Bambu rejected the login request (unauthorized)."
    )
    return r.json()


def _strip_secretish_keys(body: dict) -> dict:
    """Defense-in-depth for the MFA continuation context. The login-success/
    MFA-challenge shape is UNVERIFIED (see module docstring), so an
    unrecognized-but-still-sensitive value (a session/temp token under a key
    name not in our recognized set) could otherwise ride ``mfa_context`` all
    the way to the browser -- violating "no token ever leaves the backend".
    Drop any key whose lowercased name CONTAINS "token", or EQUALS
    "password"/"secret"/"access"/"accesstoken", while KEEPING the MFA
    continuation fields (``tfaKey``, ``loginType``, ...) the verify step
    needs. Deliberately NOT a blanket "*key*" match: ``tfaKey`` ends in
    "Key" and must survive."""
    dropped = {"password", "secret", "access", "accesstoken"}
    return {k: v for k, v in body.items() if "token" not in k.lower() and k.lower() not in dropped}


def _parse_login_response(body: dict) -> BambuLoginResult:
    """DOCUMENTED, NOT LIVE-CAPTURED (see module docstring) -- tolerant of
    several candidate field-name casings. Any recognized access+refresh
    token pair means success; otherwise the (secret-stripped) body becomes
    the opaque MFA continuation context."""
    access = body.get("accessToken") or body.get("access_token") or body.get("token")
    refresh_token = body.get("refreshToken") or body.get("refresh_token")
    if access and refresh_token:
        return BambuLoginResult(
            status="connected", access_token=access, refresh_token=refresh_token
        )
    return BambuLoginResult(status="mfa_required", mfa_context=_strip_secretish_keys(body))


def login(account: str, password: str, region: str = "global") -> BambuLoginResult:
    """One login attempt. The password is used ONLY for this one HTTP call
    -- never stored, logged, or echoed back."""
    result = _parse_login_response(_post_login({"account": account, "password": password}, region))
    return result


def verify_code(
    account: str, code: str, region: str, context: dict | None = None
) -> BambuLoginResult:
    """Complete an MFA login with the emailed/SMS code. ``context`` is
    whatever ``login()`` returned as ``mfa_context`` -- its fields (e.g. a
    documented ``tfaKey``-style continuation token) are merged into the
    request body without overriding the explicit ``account``/``code``.
    Raises ``BambuAuthError`` if Bambu still doesn't return tokens (wrong or
    expired code) rather than looping into a second MFA round, since no such
    multi-round flow is documented."""
    body: dict = {"account": account, "code": code}
    for key, value in (context or {}).items():
        body.setdefault(key, value)
    result = _parse_login_response(_post_login(body, region))
    if result.status != "connected":
        raise BambuAuthError("Bambu did not accept the verification code (wrong or expired code?).")
    return result


def refresh(refresh_token: str, region: str = "global") -> BambuAccessToken:
    """Exchange a stored refresh token for a fresh access token. Raises a
    ``kind="expired"`` ``BambuAuthError`` on an invalid/expired refresh token
    (HTTP 401, live-verified) -- the caller (``get_access_token_sync``)
    surfaces this as "reconnect your Bambu account" rather than crashing,
    AND persists a ``refresh_failed_at`` marker (``mark_refresh_failed_sync``)
    so the expiry survives past this one process/request (expiry-banner UX,
    ``GET /settings/bambu``'s ``needs_reconnect``)."""
    with _client(region) as c:
        r = c.post("/user-service/user/refreshtoken", json={"refreshToken": refresh_token})
    _raise_on_error_status(
        r,
        unauthorized_message=(
            "Bambu refresh token is invalid or expired -- reconnect the Bambu account in Settings."
        ),
        kind="expired",
    )
    body = r.json()
    access = body.get("accessToken") or body.get("access_token") or body.get("token")
    if not access:
        raise BambuAuthError("Bambu's refresh response did not include an access token.")
    new_refresh = body.get("refreshToken") or body.get("refresh_token") or refresh_token
    return BambuAccessToken(
        access_token=access,
        refresh_token=new_refresh,
        expires_at=_estimate_expiry(body, access),
    )


def _decode_jwt_exp(token: str) -> float | None:
    """Best-effort, UNVERIFIED (no signature check -- we trust the issuer,
    Bambu, not the bearer) read of a JWT's ``exp`` claim, used only as an
    expiry ESTIMATE for cache freshness. Never raises: any malformed token
    just falls through to the fixed fallback TTL in ``_estimate_expiry``."""
    try:
        _, payload_b64, _ = token.split(".")
        padding = "=" * (-len(payload_b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(payload_b64 + padding))
        exp = payload.get("exp")
        return float(exp) if exp is not None else None
    except Exception:  # noqa: BLE001 -- purely best-effort; any failure mode falls back
        return None


def _estimate_expiry(body: dict, access_token: str) -> float:
    for key in ("expiresIn", "accessTokenExpiresIn", "expires_in"):
        value = body.get(key)
        if isinstance(value, (int, float)) and value > 0:
            return time.time() + float(value) - _EXPIRY_SAFETY_MARGIN_S
    exp_claim = _decode_jwt_exp(access_token)
    if exp_claim is not None:
        return exp_claim - _EXPIRY_SAFETY_MARGIN_S
    return time.time() + _FALLBACK_ACCESS_TOKEN_TTL_S


def _decrypt_state(settings: Settings, value: dict | None) -> BambuAuthState:
    if not value:
        return BambuAuthState()
    raw = value.get("refresh_token")
    refresh_failed_at = value.get("refresh_failed_at")
    if not raw:
        return BambuAuthState(
            account=value.get("account"),
            region=value.get("region") or "global",
            refresh_failed_at=refresh_failed_at,
        )
    try:
        token = decrypt_secret(settings, raw)
    except InvalidToken:
        token = raw  # defensive legacy-plaintext fallback, mirrors import_tokens.py
    return BambuAuthState(
        account=value.get("account"),
        region=value.get("region") or "global",
        refresh_token=token,
        refresh_failed_at=refresh_failed_at,
    )


async def get_bambu_auth(db: AsyncSession, settings: Settings) -> BambuAuthState:
    row = await db.get(Setting, SETTINGS_KEY)
    return _decrypt_state(settings, row.value if row else None)


def get_bambu_auth_sync(session: SyncSession, settings: Settings) -> BambuAuthState:
    row = session.get(Setting, SETTINGS_KEY)
    return _decrypt_state(settings, row.value if row else None)


async def set_bambu_auth(
    db: AsyncSession, settings: Settings, *, account: str | None, region: str, refresh_token: str
) -> None:
    # Whole-row replace, deliberately WITHOUT a `refresh_failed_at` key: this
    # is always called with a token Bambu just accepted (a fresh login, or
    # `get_access_token_sync` persisting a rotated-on-use refresh token after
    # a SUCCESSFUL refresh), so any stale expiry marker from a previous
    # attempt must not survive it -- see `mark_refresh_failed`/`_sync` below
    # for the ONLY place that key gets written.
    value = {
        "account": account,
        "region": region,
        "refresh_token": encrypt_secret(settings, refresh_token),
    }
    row = await db.get(Setting, SETTINGS_KEY)
    if row is None:
        db.add(Setting(key=SETTINGS_KEY, value=value))
    else:
        row.value = value
    await db.commit()
    _ACCESS_TOKEN_CACHE.clear()  # credential changed -- any cached access token is stale


def set_bambu_auth_sync(
    session: SyncSession,
    settings: Settings,
    *,
    account: str | None,
    region: str,
    refresh_token: str,
) -> None:
    # See the async twin above -- same whole-row-replace-clears-the-marker
    # reasoning.
    value = {
        "account": account,
        "region": region,
        "refresh_token": encrypt_secret(settings, refresh_token),
    }
    row = session.get(Setting, SETTINGS_KEY)
    if row is None:
        session.add(Setting(key=SETTINGS_KEY, value=value))
    else:
        row.value = value
    session.commit()
    _ACCESS_TOKEN_CACHE.clear()


async def clear_bambu_auth(db: AsyncSession, settings: Settings) -> None:
    row = await db.get(Setting, SETTINGS_KEY)
    if row is not None:
        await db.delete(row)
        await db.commit()
    _ACCESS_TOKEN_CACHE.clear()


def _utc_now_iso() -> str:
    return datetime.now(UTC).isoformat()


# ---------------------------------------------------------------------------
# Expiry marker (`refresh_failed_at`, task: expiry-banner UX -- see module
# docstring's "re-login UX with expiry banner"). A NON-SECRET, UTC-ISO
# timestamp patched onto the SAME `bambu_auth` settings row, next to
# `account`/`region`/the encrypted `refresh_token` -- never a new row, never
# logged, never containing a token value itself. `mark_*` is only ever
# called right after a `refresh()` call that raised `kind="expired"`
# (see `get_access_token_sync`); `clear_*` handles the one case a fresh
# `set_bambu_auth(_sync)` write doesn't already cover for free (a refresh
# that succeeds WITHOUT rotating the refresh token, so no such write
# happens) -- see `get_access_token_sync` below. Both are no-ops when
# nothing is connected (nothing to stamp/clear) so a caller never needs to
# guard the call itself.
#
# `mark_*` additionally take the REJECTED refresh token and only stamp when
# the row's CURRENT refresh token still equals it (compare-and-set, post-
# review fix M1). Two workers can race to refresh the same expiring token:
# if worker A wins and rotates in a new, valid refresh token first (which
# also clears any marker -- see `set_bambu_auth`/`_sync` above), worker B's
# now-stale rejection must not stamp a failure onto that already-healthy
# row. `populate_existing=True` forces a fresh read past this session's own
# identity map (both sessionmakers use `expire_on_commit=False`, so a row
# fetched earlier in the SAME session -- e.g. by `get_bambu_auth_sync` at
# the top of `get_access_token_sync` -- would otherwise still show the
# pre-race snapshot even after another session committed the rotation).
# Comparison is plain equality on the DECRYPTED value -- Fernet ciphertext
# isn't stable across encryptions of the same plaintext, and neither side of
# the comparison is ever logged or printed.
# ---------------------------------------------------------------------------


def _decrypt_refresh_token(settings: Settings, raw: str) -> str:
    try:
        return decrypt_secret(settings, raw)
    except InvalidToken:
        return raw  # defensive legacy-plaintext fallback, mirrors _decrypt_state


async def mark_refresh_failed(
    db: AsyncSession, settings: Settings, rejected_refresh_token: str
) -> None:
    row = await db.get(Setting, SETTINGS_KEY, populate_existing=True)
    if row is None or not row.value or not row.value.get("refresh_token"):
        return
    stored = _decrypt_refresh_token(settings, row.value["refresh_token"])
    if stored != rejected_refresh_token:
        return
    row.value = {**row.value, "refresh_failed_at": _utc_now_iso()}
    await db.commit()


def mark_refresh_failed_sync(
    session: SyncSession, settings: Settings, rejected_refresh_token: str
) -> None:
    row = session.get(Setting, SETTINGS_KEY, populate_existing=True)
    if row is None or not row.value or not row.value.get("refresh_token"):
        return
    stored = _decrypt_refresh_token(settings, row.value["refresh_token"])
    if stored != rejected_refresh_token:
        return
    row.value = {**row.value, "refresh_failed_at": _utc_now_iso()}
    session.commit()


async def clear_refresh_failed(db: AsyncSession, settings: Settings) -> None:
    row = await db.get(Setting, SETTINGS_KEY)
    if row is None or not row.value or "refresh_failed_at" not in row.value:
        return
    value = dict(row.value)
    value.pop("refresh_failed_at", None)
    row.value = value
    await db.commit()


def clear_refresh_failed_sync(session: SyncSession, settings: Settings) -> None:
    row = session.get(Setting, SETTINGS_KEY)
    if row is None or not row.value or "refresh_failed_at" not in row.value:
        return
    value = dict(row.value)
    value.pop("refresh_failed_at", None)
    row.value = value
    session.commit()


def get_access_token_sync(session: SyncSession, settings: Settings) -> str:
    """A currently-valid Bambu access token for worker use (MakerWorld's
    authenticated download/search calls, ``app.importers.makerworld``). An
    in-memory cache (module-level, NOT persisted -- see module docstring)
    keyed by the stored refresh token avoids re-hitting Bambu's refresh
    endpoint for every file within a multi-file import. Raises a
    ``kind="not_configured"`` ``BambuAuthError`` with a clear "not connected"
    message when no account is connected, or whatever ``refresh()`` raises
    (``kind="expired"`` on an invalid/expired refresh token) when the stored
    refresh token itself is no longer valid -- THAT case also persists
    ``refresh_failed_at`` (``mark_refresh_failed_sync``) so the expiry
    survives past this one call (expiry-banner UX).
    """
    state = get_bambu_auth_sync(session, settings)
    if not state.refresh_token:
        raise BambuAuthError(
            "no Bambu account is connected -- connect one in Settings.", kind="not_configured"
        )
    cached = _ACCESS_TOKEN_CACHE.get(state.refresh_token)
    if cached is not None and cached[1] > time.time():
        return cached[0]
    try:
        token = refresh(state.refresh_token, state.region)
    except BambuAuthError as exc:
        if exc.kind == "expired":
            mark_refresh_failed_sync(session, settings, state.refresh_token)
        raise
    if token.refresh_token != state.refresh_token:
        # Bambu may rotate the refresh token on use -- persist the new one
        # BEFORE caching the access token below (set_bambu_auth_sync clears
        # the whole cache as part of a credential change), so the entry we
        # add next isn't immediately wiped out by that same clear. This also
        # clears any stale `refresh_failed_at` marker for free (whole-row
        # replace -- see set_bambu_auth_sync's comment).
        set_bambu_auth_sync(
            session,
            settings,
            account=state.account,
            region=state.region,
            refresh_token=token.refresh_token,
        )
    elif state.refresh_failed_at:
        # No rotation, so the write above didn't happen -- but this refresh
        # JUST succeeded, so a marker from an earlier failed attempt on this
        # same still-valid refresh token must not keep reporting
        # `needs_reconnect: true` forever.
        clear_refresh_failed_sync(session, settings)
    _ACCESS_TOKEN_CACHE[token.refresh_token] = (token.access_token, token.expires_at)
    return token.access_token
