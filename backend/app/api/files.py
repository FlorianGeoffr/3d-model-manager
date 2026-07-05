"""File deletion, restricted to a model's current revision (SPEC "API
surface", Task 5 brief). Download/upload land here in Task 6.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.db import get_db
from app.services import library
from app.storage.base import StorageBackend
from app.storage.registry import get_backend

router = APIRouter(prefix="/files", tags=["files"])


def _backend(settings: Settings = Depends(get_settings)) -> StorageBackend:
    return get_backend(settings)


@router.delete("/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_file(
    file_id: int,
    db: AsyncSession = Depends(get_db),
    backend: StorageBackend = Depends(_backend),
) -> None:
    await library.delete_file(db, backend, file_id)
