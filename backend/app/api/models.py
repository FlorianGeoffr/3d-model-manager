"""Model CRUD + gallery listing (SPEC "API surface", Task 5 brief)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_storage_backend
from app.config import Settings, get_settings
from app.db import get_db
from app.schemas.library import GalleryPage, ModelCreate, ModelDetail, ModelPatch
from app.services import library
from app.storage.base import StorageBackend

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
    settings: Settings = Depends(get_settings),
) -> ModelDetail:
    model = await library.get_model_by_slug(db, slug)
    model = await library.patch_model(db, model, payload.model_dump(exclude_unset=True))
    return await library.build_model_detail(db, model, settings)


@router.delete("/{slug}", status_code=status.HTTP_204_NO_CONTENT)
async def archive_model(slug: str, db: AsyncSession = Depends(get_db)) -> None:
    model = await library.get_model_by_slug(db, slug)
    await library.archive_model(db, model)
