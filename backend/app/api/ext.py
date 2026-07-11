"""Browser-extension endpoints (M10 Workstream A). Token-gated (see
``app.api.deps.require_api_token``), NOT session-gated -- mounted directly
on ``api_router`` (``app/api/__init__.py``), outside ``protected_router``,
so it carries only its own ``require_api_token`` dependency and none of the
session-cookie surface.

Deliberately narrow: exactly three endpoints, matching what the extension
needs to do (prove it has a live token, start an import, hand over a
MakerWorld cookie) and nothing else -- a leaked extension token must not be
able to delete models, read other secrets, or touch storage config.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Response, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_api_token
from app.config import Settings, get_settings
from app.db import get_db
from app.schemas.imports import ImportCreate, ImportOut, NonEmptyStr
from app.services import import_tokens
from app.services.imports import start_import

router = APIRouter(prefix="/ext", tags=["ext"], dependencies=[Depends(require_api_token)])


class ExtCredentialIn(BaseModel):
    token: NonEmptyStr


class OkOut(BaseModel):
    ok: bool = True


@router.get("/ping", response_model=OkOut)
async def ping() -> OkOut:
    """Validates the token (the dependency already ran); used by the
    extension's "Test connection" action."""
    return OkOut()


@router.post("/imports", status_code=status.HTTP_201_CREATED, response_model=ImportOut)
async def create_import(
    payload: ImportCreate, response: Response, db: AsyncSession = Depends(get_db)
) -> ImportOut:
    """Mirrors ``POST /imports`` (``app.api.imports.create_import``) exactly
    -- same ``start_import`` call, same 200-vs-201 dedup signal -- reused
    verbatim rather than reimplemented so the two entry points can't drift.
    """
    imp, created = await start_import(db, payload.url)
    if not created:
        response.status_code = status.HTTP_200_OK
    return ImportOut.from_model(imp)


@router.post("/credentials/makerworld", response_model=OkOut)
async def set_makerworld_credential(
    payload: ExtCredentialIn,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> OkOut:
    """The extension couriers the operator's browser-side MakerWorld cookie
    here. Merge-set: read the currently stored tokens and keep
    ``thingiverse_token`` as-is (mirrors ``_merge_import_token`` in
    ``app.api.settings``) so setting MakerWorld never clobbers a separately
    configured Thingiverse token. The token is never echoed back.
    """
    current = await import_tokens.get_import_tokens(db, settings)
    await import_tokens.set_import_tokens(
        db, settings, thingiverse_token=current.thingiverse_token, makerworld_token=payload.token
    )
    return OkOut()
