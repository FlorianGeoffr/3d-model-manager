"""Model CRUD + gallery listing (SPEC "API surface", Task 5 brief)."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_storage_backend
from app.config import Settings, get_settings
from app.db import get_db
from app.schemas.jobs import JobOut
from app.schemas.library import GalleryPage, ModelCreate, ModelDetail, ModelPatch, ModelRelocateIn
from app.services import jobs as jobs_service
from app.services import library
from app.services import storage_backends as storage_backends_service
from app.storage.base import StorageBackend
from app.tasks.relocate import relocate_model_storage

router = APIRouter(prefix="/models", tags=["models"])


@router.post("", status_code=status.HTTP_201_CREATED, response_model=ModelDetail)
async def create_model(
    payload: ModelCreate,
    db: AsyncSession = Depends(get_db),
    backend: StorageBackend = Depends(get_storage_backend),
    settings: Settings = Depends(get_settings),
) -> ModelDetail:
    model = await library.create_model(
        db, backend, name=payload.name, description=payload.description
    )
    return await library.build_model_detail(db, model, settings)


@router.get("", response_model=GalleryPage)
async def list_models(
    q: str | None = None,
    tag: str | None = None,
    format: str | None = None,
    has_sliced: bool | None = None,
    sort: str = "-updated_at",
    archived: bool = False,
    limit: int = Query(20, ge=1, le=100),
    cursor: str | None = None,
    db: AsyncSession = Depends(get_db),
) -> GalleryPage:
    items, next_cursor = await library.list_models(
        db,
        q=q,
        tag=tag,
        format_=format,
        has_sliced=has_sliced,
        sort=sort,
        archived=archived,
        limit=limit,
        cursor=cursor,
    )
    return GalleryPage(items=items, next_cursor=next_cursor)


@router.get("/{slug}", response_model=ModelDetail)
async def get_model(
    slug: str, db: AsyncSession = Depends(get_db), settings: Settings = Depends(get_settings)
) -> ModelDetail:
    model = await library.get_model_by_slug(db, slug)
    return await library.build_model_detail(db, model, settings)


@router.patch("/{slug}", response_model=ModelDetail)
async def patch_model(
    slug: str,
    payload: ModelPatch,
    db: AsyncSession = Depends(get_db),
    backend: StorageBackend = Depends(get_storage_backend),
    settings: Settings = Depends(get_settings),
) -> ModelDetail:
    model = await library.get_model_by_slug(db, slug)
    model = await library.patch_model(db, backend, model, payload.model_dump(exclude_unset=True))
    return await library.build_model_detail(db, model, settings)


@router.delete("/{slug}", status_code=status.HTTP_204_NO_CONTENT)
async def archive_model(slug: str, db: AsyncSession = Depends(get_db)) -> None:
    model = await library.get_model_by_slug(db, slug)
    await library.archive_model(db, model)


@router.post("/{slug}/relocate", response_model=JobOut)
async def relocate_model(
    slug: str,
    payload: ModelRelocateIn,
    db: AsyncSession = Depends(get_db),
) -> JobOut:
    """Dispatch ``app.tasks.relocate.relocate_model_storage`` (Workstream C
    task C3) to move or replicate every file of this model, across all its
    revisions, onto ``payload.target_backend_id``. ``mode`` is already
    constrained to ``{"move", "replicate"}`` at the schema boundary
    (``ModelRelocateIn``); a nonexistent target backend 404s here (via
    ``get_backend_row``) before a job row is ever created.
    """
    model = await library.get_model_by_slug(db, slug)
    await storage_backends_service.get_backend_row(db, payload.target_backend_id)

    job = await jobs_service.create_job(
        db,
        id=uuid.uuid4(),
        type="relocate_model_storage",
        subject_type="model",
        subject_id=model.id,
    )
    relocate_model_storage.apply_async(
        args=[str(job.id), model.id, payload.target_backend_id, payload.mode],
        task_id=str(job.id),
    )

    # Under the test suite's eager Celery mode, the line above already ran
    # the whole relocate inline through its own SYNC session -- refresh so
    # this (separate, async) session's identity map doesn't hand back the
    # stale "queued" snapshot from right after the insert (same reasoning as
    # app.api.settings.migrate_storage_settings).
    await db.refresh(job)
    return JobOut.from_model(job)
