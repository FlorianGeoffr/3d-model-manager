"""File deletion + download, restricted to/scoped by a model's current
revision where relevant (SPEC "API surface", Task 5 brief + Task 6 interface
decisions).
"""

from __future__ import annotations

from pathlib import PurePosixPath

import anyio
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import iterate_in_threadpool

from app.config import Settings, get_settings
from app.db import get_db
from app.models import Blob, File
from app.services import library
from app.storage.base import StorageBackend
from app.storage.errors import StorageKeyNotFound
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


@router.get("/{file_id}/download")
async def download_file(
    file_id: int,
    db: AsyncSession = Depends(get_db),
    backend: StorageBackend = Depends(_backend),
) -> StreamingResponse:
    """Stream a file's bytes from the storage backend (Task 6 interface
    decision). 409 if the file hasn't finished being stored yet (NULL
    ``verified_at`` and the backend object genuinely doesn't exist -- a NULL
    ``verified_at`` with an already-present object, e.g. a race with a
    scanner, is not treated as "processing").
    """
    file = await db.get(File, file_id)
    if file is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"file {file_id} not found")

    if file.verified_at is None:
        exists = await anyio.to_thread.run_sync(backend.exists, file.storage_path)
        if not exists:
            raise HTTPException(status.HTTP_409_CONFLICT, "file is still processing")

    blob = await db.get(Blob, file.blob_hash)
    filename = PurePosixPath(file.rel_path).name
    try:
        iterator = await anyio.to_thread.run_sync(backend.read, file.storage_path)
    except StorageKeyNotFound as exc:
        # `verified_at` says the backend write succeeded, but the object is
        # gone now -- removed out-of-band (e.g. manual disk edit, a scanner
        # cleanup). That's a 404, not the 409 "still processing" above.
        raise HTTPException(status.HTTP_404_NOT_FOUND, "file missing from storage") from exc

    return StreamingResponse(
        iterate_in_threadpool(iterator),
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(blob.size),
        },
    )
