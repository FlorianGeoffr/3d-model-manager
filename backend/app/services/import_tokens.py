"""Gallery-import site tokens (SPEC Thingiverse "user-supplied app token in
Settings"; task A5 added the MakerWorld web token the same way). Stored in
the ``settings`` table under key ``import_tokens`` as
``{"thingiverse_token": ..., "makerworld_token": ...}``. M6 A1: each token is
Fernet-encrypted at rest (the same ``app.crypto`` seam as the M4 printer
access code and the M6 storage secrets), masked on read at the API layer
(controller decision 2; same posture as storage secrets). A pre-M6 plaintext
row still reads correctly via the per-field ``InvalidToken`` fallback and is
eagerly re-encrypted by ``app.services.secrets_at_rest``. Each token is read
ONLY inside the worker to build the site's auth header/cookie; never
returned by a GET, never logged."""

from __future__ import annotations

from cryptography.fernet import InvalidToken
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session as SyncSession

from app.config import Settings
from app.crypto import decrypt_secret, encrypt_secret
from app.models import Setting

SETTINGS_KEY = "import_tokens"


class ImportTokens(BaseModel):
    thingiverse_token: str | None = None
    makerworld_token: str | None = None


def _decrypt_field(settings: Settings, value: dict, field: str) -> str | None:
    raw = value.get(field)
    if not raw:
        return None
    try:
        return decrypt_secret(settings, raw)
    except InvalidToken:
        return raw  # legacy plaintext


def _decrypt_token(settings: Settings, value: dict | None) -> ImportTokens:
    if not value:
        return ImportTokens()
    return ImportTokens(
        thingiverse_token=_decrypt_field(settings, value, "thingiverse_token"),
        makerworld_token=_decrypt_field(settings, value, "makerworld_token"),
    )


async def get_import_tokens(db: AsyncSession, settings: Settings) -> ImportTokens:
    row = await db.get(Setting, SETTINGS_KEY)
    return _decrypt_token(settings, row.value if row else None)


def get_import_tokens_sync(session: SyncSession, settings: Settings) -> ImportTokens:
    row = session.get(Setting, SETTINGS_KEY)
    return _decrypt_token(settings, row.value if row else None)


async def set_import_tokens(
    db: AsyncSession,
    settings: Settings,
    *,
    thingiverse_token: str | None,
    makerworld_token: str | None,
) -> None:
    row = await db.get(Setting, SETTINGS_KEY)
    if thingiverse_token is None and makerworld_token is None and row is None:
        # Clearing tokens that were never stored: nothing to store and
        # nothing to clear -- don't create a null Setting row (M6 C3d).
        return
    value = {
        "thingiverse_token": encrypt_secret(settings, thingiverse_token)
        if thingiverse_token
        else None,
        "makerworld_token": encrypt_secret(settings, makerworld_token)
        if makerworld_token
        else None,
    }
    if row is None:
        db.add(Setting(key=SETTINGS_KEY, value=value))
    else:
        row.value = value
    await db.commit()


async def set_thingiverse_token(db: AsyncSession, settings: Settings, token: str | None) -> None:
    """Thin single-field convenience wrapper kept for the pre-A5 call shape
    (the API layer now resolves both fields per-request and calls
    ``set_import_tokens`` directly with both, so this has no production
    caller of its own) -- reads the current row so a Thingiverse-only write
    doesn't clobber a stored ``makerworld_token``."""
    current = await get_import_tokens(db, settings)
    await set_import_tokens(
        db, settings, thingiverse_token=token, makerworld_token=current.makerworld_token
    )
