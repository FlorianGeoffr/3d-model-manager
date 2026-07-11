"""Browser-extension endpoints (M10 Workstream A). Token-gated (see
``app.api.deps.require_api_token``), NOT session-gated -- mounted directly
on ``api_router`` (``app/api/__init__.py``), outside ``protected_router``,
so it carries only its own ``require_api_token`` dependency and none of the
session-cookie surface.

Deliberately narrow: exactly four endpoints, matching what the extension
needs to do (prove it has a live token, start an import, hand over a
MakerWorld cookie, push the real MakerWorld collection list it can see in the
user's authenticated browser) and nothing else -- a leaked extension token
must not be able to delete models, read other secrets, or touch storage
config.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Response, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_api_token
from app.config import Settings, get_settings
from app.db import get_db
from app.models.enums import ImportSite
from app.schemas.imports import ImportCreate, ImportOut, NonEmptyStr
from app.services import import_tokens, remote_collections
from app.services.imports import start_import

router = APIRouter(prefix="/ext", tags=["ext"], dependencies=[Depends(require_api_token)])

# Abuse guard: a runaway/misbehaving extension push shouldn't be able to
# write an unbounded number of rows in one request.
_MAX_PUSHED_COLLECTIONS = 200


class ExtCredentialIn(BaseModel):
    token: NonEmptyStr


class OkOut(BaseModel):
    ok: bool = True


class ExtCollectionEntryIn(BaseModel):
    list_id: NonEmptyStr
    title: NonEmptyStr
    slug: str | None = None
    count: int | None = None
    is_default: bool = False


class ExtCollectionsPushIn(BaseModel):
    site: ImportSite
    collections: Annotated[list[ExtCollectionEntryIn], Field(max_length=_MAX_PUSHED_COLLECTIONS)]


class ExtCollectionsPushOut(BaseModel):
    ok: bool = True
    count: int


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


@router.post("/collections", response_model=ExtCollectionsPushOut)
async def push_collections(
    payload: ExtCollectionsPushIn, db: AsyncSession = Depends(get_db)
) -> ExtCollectionsPushOut:
    """The extension pushes the real collection list for ``site`` here --
    it runs in the user's authenticated browser, where MakerWorld's
    Cloudflare wall around the SSR collections route isn't up (see
    ``app.importers.makerworld``'s module docstring). Authoritative full-list
    replace, not an incremental merge: anything cached for ``site`` but not
    in this push is deleted (``app.services.remote_collections
    .replace_site_cache``) -- a collection the user deleted/unfollowed on the
    remote site should disappear from the cache too.
    """
    entries = [
        remote_collections.CacheEntry(
            list_id=entry.list_id,
            title=entry.title,
            slug=entry.slug,
            count=entry.count,
            is_default=entry.is_default,
        )
        for entry in payload.collections
    ]
    count = await remote_collections.replace_site_cache(db, payload.site, entries)
    return ExtCollectionsPushOut(count=count)
