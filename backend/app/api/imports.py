"""Gallery import endpoints (SPEC "API surface": imports (create/poll)).
POST detects the site from the URL, creates a ``pending`` Import row, and
dispatches ``import_from_url``; GET/{id} + list poll the row (the primary
read path -- richer than the generic jobs row). A MakerWorld URL yields a
friendly 422 (deferred), never a crash."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.importers.registry import build_importer_for_url, deferred_site_for_url
from app.models.enums import ImportSite, ImportState
from app.models.system import Import
from app.schemas.imports import ImportCreate, ImportOut
from app.tasks.importing import import_from_url

router = APIRouter(prefix="/imports", tags=["imports"])


@router.post("", status_code=status.HTTP_201_CREATED, response_model=ImportOut)
async def create_import(payload: ImportCreate, db: AsyncSession = Depends(get_db)) -> ImportOut:
    url = payload.url
    importer = build_importer_for_url(url)
    if importer is None:
        if deferred_site_for_url(url) is ImportSite.MAKERWORLD:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT,
                "MakerWorld import isn't available yet.",
            )
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "Unsupported URL -- paste a Thingiverse or Printables model link.",
        )
    external_id = importer.canonicalize(url)
    imp = Import(url=url, site=importer.site, external_id=external_id, state=ImportState.PENDING)
    db.add(imp)
    await db.commit()
    await db.refresh(imp)

    import_from_url.apply_async(args=[imp.id], task_id=f"import-{imp.id}")

    # Under eager Celery (tests) the line above ran the whole import inline
    # through its own SYNC session, driving the row to done/failed -- refresh
    # so this async session hands back the terminal state, not the stale
    # "pending" snapshot (same reasoning as app.api.settings.migrate).
    await db.refresh(imp)
    return ImportOut.from_model(imp)


@router.get("", response_model=list[ImportOut])
async def list_imports(limit: int = 50, db: AsyncSession = Depends(get_db)) -> list[ImportOut]:
    rows = (
        (await db.execute(select(Import).order_by(Import.created_at.desc()).limit(limit)))
        .scalars()
        .all()
    )
    return [ImportOut.from_model(r) for r in rows]


@router.get("/{import_id}", response_model=ImportOut)
async def get_import(import_id: int, db: AsyncSession = Depends(get_db)) -> ImportOut:
    imp = await db.get(Import, import_id)
    if imp is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"import {import_id} not found")
    return ImportOut.from_model(imp)
