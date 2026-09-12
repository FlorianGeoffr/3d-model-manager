"""Model CRUD + gallery listing (SPEC "API surface", Task 5 brief)."""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_storage_backend
from app.config import Settings, get_settings
from app.db import get_db
from app.schemas.jobs import JobOut
from app.schemas.library import (
    GalleryPage,
    ModelBulkDeleteIn,
    ModelBulkDeleteOut,
    ModelBulkIn,
    ModelBulkOut,
    ModelCreate,
    ModelDetail,
    ModelPatch,
    ModelRedownloadIn,
    ModelRelocateIn,
)
from app.services import jobs as jobs_service
from app.services import library, zip_export
from app.services import storage_backends as storage_backends_service
from app.services.http_names import content_disposition_attachment
from app.storage.base import StorageBackend
from app.tasks.importing import redownload_model as redownload_model_task
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
    collection: int | None = None,
    favorite: bool | None = None,
    sort: str = "-updated_at",
    archived: bool = False,
    limit: int = Query(20, ge=1, le=100),
    cursor: str | None = None,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> GalleryPage:
    items, next_cursor = await library.list_models(
        db,
        settings,
        q=q,
        tag=tag,
        format_=format,
        has_sliced=has_sliced,
        collection=collection,
        favorite=favorite,
        sort=sort,
        archived=archived,
        limit=limit,
        cursor=cursor,
    )
    return GalleryPage(items=items, next_cursor=next_cursor)


@router.post("/bulk", response_model=ModelBulkOut)
async def bulk_update_models(
    payload: ModelBulkIn, db: AsyncSession = Depends(get_db)
) -> ModelBulkOut:
    """Declared BEFORE ``/{slug}`` (Branch 4 Task 1) -- FastAPI matches
    routes in declaration order, so a literal ``/bulk`` segment must come
    before the ``{slug}`` path-param routes or it would be parsed as a slug.
    """
    updated = await library.bulk_update_models(
        db,
        ids=payload.ids,
        add_tags=payload.add_tags,
        remove_tags=payload.remove_tags,
        favorite=payload.favorite,
    )
    return ModelBulkOut(updated=updated)


@router.post("/bulk-delete", response_model=ModelBulkDeleteOut)
async def bulk_delete_models(
    payload: ModelBulkDeleteIn,
    db: AsyncSession = Depends(get_db),
    backend: StorageBackend = Depends(get_storage_backend),
    settings: Settings = Depends(get_settings),
) -> ModelBulkDeleteOut:
    """Declared BEFORE ``/{slug}`` (same reasoning as ``/bulk`` above) --
    FastAPI matches routes in declaration order, so a literal ``/bulk-delete``
    segment must come before the ``{slug}`` path-param routes or it would be
    parsed as a slug.
    """
    deleted = await library.bulk_hard_delete_models(db, backend, settings, ids=payload.ids)
    return ModelBulkDeleteOut(deleted=deleted)


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
async def delete_model(
    slug: str,
    db: AsyncSession = Depends(get_db),
    backend: StorageBackend = Depends(get_storage_backend),
    settings: Settings = Depends(get_settings),
) -> None:
    """A REAL delete (feat/import-fidelity T3) -- physically destroys every
    revision's files (its primary backend AND every replica) plus the
    model's ``.3dmm.json`` sidecar, then the ``Model`` row itself (DB
    cascades take the rest). Soft-delete ("archive") moved to ``PATCH
    {"is_archived": true}`` -- see ``patch_model``/``ModelPatch`` -- since
    this endpoint no longer offers a reversible option.
    """
    model = await library.get_model_by_slug(db, slug)
    await library.hard_delete_model(db, backend, settings, model)


@router.post("/{slug}/redownload", response_model=JobOut)
async def redownload_model(
    slug: str,
    payload: ModelRedownloadIn,
    db: AsyncSession = Depends(get_db),
) -> JobOut:
    """Re-fetches this model's files fresh from its original import source
    (feat/import-fidelity T3): dispatches
    ``app.tasks.importing.redownload_model``, which either lands the fresh
    download as a NEW revision (``mode="revision"``, old revision untouched)
    or overwrites the CURRENT revision's files in place
    (``mode="replace"``). 409 unless the model still has a resolvable import
    source -- ``library.check_redownload_source`` reuses the same registry +
    ``canonicalize`` seam ``app.services.imports.start_import`` uses to
    validate a fresh import's URL.

    Deliberately does NOT consult
    ``app.services.import_dedup.find_live_import`` -- that guard exists so a
    SECOND import can't create a second Model for a remote source already in
    the library. A re-download targets THIS existing model by id and never
    creates a new Model, so the guard doesn't apply: it's model-scoped by
    design, not source-scoped.
    """
    model = await library.get_model_by_slug(db, slug)
    library.check_redownload_source(model)

    job = await jobs_service.create_job(
        db,
        id=uuid.uuid4(),
        type="redownload_model",
        subject_type="model",
        subject_id=model.id,
    )
    redownload_model_task.apply_async(
        args=[str(job.id), model.id, payload.mode], task_id=str(job.id)
    )

    # Under the test suite's eager Celery mode, the line above already ran
    # the whole redownload inline through its own SYNC session -- refresh so
    # this (separate, async) session's identity map doesn't hand back the
    # stale "queued" snapshot from right after the insert (same reasoning as
    # `relocate_model` below).
    await db.refresh(job)
    return JobOut.from_model(job)


@router.get("/{slug}/zip")
async def download_model_zip(
    slug: str,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> StreamingResponse:
    """Stream a zip of ``model``'s current revision (plan item 12): every
    current-revision file plus a ``README.txt`` with provenance. 409 if the
    model has zero files -- there'd be nothing to zip."""
    model = await library.get_model_by_slug(db, slug)
    try:
        _chunk, body = await zip_export.first_chunk(zip_export.iter_model_zip(db, settings, model))
    except zip_export.EmptyModelError as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc

    return StreamingResponse(
        body,
        media_type="application/zip",
        headers={"Content-Disposition": content_disposition_attachment(f"{model.slug}.zip")},
    )


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
