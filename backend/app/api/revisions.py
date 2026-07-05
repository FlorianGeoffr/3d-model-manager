"""Revision listing/creation, revision detail, and revision diff (SPEC "API
surface", Task 5 brief).

Model-scoped listing/creation are keyed by the model's numeric id
(``/models/{model_id}/revisions``), distinct from the slug-keyed
``/models/{slug}`` detail routes in ``app.api.models`` -- that split is
exactly what the Task 5 brief specifies.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.db import get_db
from app.schemas.library import DiffResponse, RevisionCreate, RevisionDetail, RevisionSummary
from app.services import library
from app.storage.base import StorageBackend
from app.storage.registry import get_backend

router = APIRouter(tags=["revisions"])


def _backend(settings: Settings = Depends(get_settings)) -> StorageBackend:
    return get_backend(settings)


@router.get("/models/{model_id}/revisions", response_model=list[RevisionSummary])
async def list_revisions(
    model_id: int, db: AsyncSession = Depends(get_db)
) -> list[RevisionSummary]:
    model = await library.get_model_by_id(db, model_id)
    return await library.list_revisions(db, model)


@router.post(
    "/models/{model_id}/revisions",
    status_code=status.HTTP_201_CREATED,
    response_model=RevisionDetail,
)
async def create_revision(
    model_id: int,
    payload: RevisionCreate,
    db: AsyncSession = Depends(get_db),
    backend: StorageBackend = Depends(_backend),
) -> RevisionDetail:
    model = await library.get_model_by_id(db, model_id)
    revision = await library.create_revision(
        db, backend, model, name=payload.name, note=payload.note
    )
    return await library.build_revision_detail(db, revision)


@router.get("/revisions/{revision_id}", response_model=RevisionDetail)
async def get_revision(revision_id: int, db: AsyncSession = Depends(get_db)) -> RevisionDetail:
    revision = await library.get_revision_or_404(db, revision_id)
    return await library.build_revision_detail(db, revision)


@router.get("/revisions/{revision_a_id}/diff/{revision_b_id}", response_model=DiffResponse)
async def diff_revisions(
    revision_a_id: int, revision_b_id: int, db: AsyncSession = Depends(get_db)
) -> DiffResponse:
    return await library.diff_revisions(db, revision_a_id, revision_b_id)
