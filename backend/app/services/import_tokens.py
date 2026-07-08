"""Gallery-import site tokens (SPEC Thingiverse "user-supplied app token in
Settings"). Stored in the ``settings`` table under key ``import_tokens`` as
``{"thingiverse_token": "..."}``. M6 A1: the token is Fernet-encrypted at
rest (the same ``app.crypto`` seam as the M4 printer access code and the M6
storage secrets), masked on read at the API layer (controller decision 2;
same posture as storage secrets). A pre-M6 plaintext row still reads
correctly via the ``InvalidToken`` fallback and is eagerly re-encrypted by
``app.services.secrets_at_rest``. The token is read ONLY inside the worker
to build an Authorization header; never returned by a GET, never logged."""

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


def _decrypt_token(settings: Settings, value: dict | None) -> ImportTokens:
    if not value or not value.get("thingiverse_token"):
        return ImportTokens()
    raw = value["thingiverse_token"]
    try:
        return ImportTokens(thingiverse_token=decrypt_secret(settings, raw))
    except InvalidToken:
        return ImportTokens(thingiverse_token=raw)  # legacy plaintext


async def get_import_tokens(db: AsyncSession, settings: Settings) -> ImportTokens:
    row = await db.get(Setting, SETTINGS_KEY)
    return _decrypt_token(settings, row.value if row else None)


def get_import_tokens_sync(session: SyncSession, settings: Settings) -> ImportTokens:
    row = session.get(Setting, SETTINGS_KEY)
    return _decrypt_token(settings, row.value if row else None)


async def set_thingiverse_token(db: AsyncSession, settings: Settings, token: str | None) -> None:
    row = await db.get(Setting, SETTINGS_KEY)
    if token is None and row is None:
        # Clearing a token that was never stored: nothing to store and
        # nothing to clear -- don't create a null Setting row (M6 C3d).
        return
    stored = encrypt_secret(settings, token) if token else None
    value = {"thingiverse_token": stored}
    if row is None:
        db.add(Setting(key=SETTINGS_KEY, value=value))
    else:
        row.value = value
    await db.commit()
