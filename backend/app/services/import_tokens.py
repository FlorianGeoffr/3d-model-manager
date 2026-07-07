"""Gallery-import site tokens (SPEC Thingiverse "user-supplied app token in
Settings"). Stored in the ``settings`` table under key ``import_tokens`` as
``{"thingiverse_token": "..."}`` -- plaintext, masked on read at the API
layer (controller decision 2; same posture as storage secrets). The token is
read ONLY inside the worker to build an Authorization header; never returned
by a GET, never logged."""

from __future__ import annotations

from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session as SyncSession

from app.models import Setting

SETTINGS_KEY = "import_tokens"


class ImportTokens(BaseModel):
    thingiverse_token: str | None = None


async def get_import_tokens(db: AsyncSession) -> ImportTokens:
    row = await db.get(Setting, SETTINGS_KEY)
    return ImportTokens() if row is None else ImportTokens(**row.value)


def get_import_tokens_sync(session: SyncSession) -> ImportTokens:
    row = session.get(Setting, SETTINGS_KEY)
    return ImportTokens() if row is None else ImportTokens(**row.value)


async def set_thingiverse_token(db: AsyncSession, token: str | None) -> None:
    tokens = await get_import_tokens(db)
    tokens.thingiverse_token = token
    row = await db.get(Setting, SETTINGS_KEY)
    value = tokens.model_dump()
    if row is None:
        db.add(Setting(key=SETTINGS_KEY, value=value))
    else:
        row.value = value
    await db.commit()
