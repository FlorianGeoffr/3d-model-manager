"""File deletion + download, restricted to/scoped by a model's current
revision where relevant (SPEC "API surface", Task 5 brief + Task 6 interface
decisions).
"""

from __future__ import annotations

import io
import zipfile
from pathlib import PurePosixPath

import anyio
from fastapi import APIRouter, Depends, HTTPException, Query, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import iterate_in_threadpool

from app.config import Settings, get_settings
from app.db import get_db
from app.models import Blob, File
from app.models.enums import BlobFormat
from app.pipeline import slicedmeta
from app.services import library
from app.services.storage_backends import resolve_backend_for_file
from app.storage.errors import StorageKeyNotFound

router = APIRouter(prefix="/files", tags=["files"])


@router.delete("/{file_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_file(
    file_id: int,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> None:
    await library.delete_file(db, settings, file_id)


def _extract_embedded_gcode(data: bytes, plate: int | None) -> bytes:
    """Pull one plate's embedded ``.gcode`` member out of a ``.gcode.3mf``
    zip (R10-B: ``?member=gcode`` download param for the frontend's
    ``GcodePreview``), via the same ``model_settings.config`` plate->gcode
    mapping the pipeline's own metadata extraction uses. Defaults to the
    lowest-numbered plate when ``plate`` is omitted.
    """
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        model_settings = slicedmeta.read_zip_member(zf, slicedmeta.MODEL_SETTINGS_PATH)
        plate_files = slicedmeta.parse_model_settings(model_settings)
        if not plate_files:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "no embedded gcode in this file")
        chosen = plate if plate is not None else min(plate_files)
        gcode_member = (plate_files.get(chosen) or {}).get("gcode_file")
        if gcode_member is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, f"no gcode for plate {chosen}")
        try:
            return zf.read(gcode_member)
        except KeyError as exc:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "embedded gcode member missing") from exc


@router.get("/{file_id}/download")
async def download_file(
    file_id: int,
    member: str | None = Query(None, description="'gcode' extracts a .gcode.3mf's embedded gcode"),
    plate: int | None = Query(None, description="Plate index for member=gcode; default lowest"),
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> StreamingResponse:
    """Stream a file's bytes from the storage backend (Task 6 interface
    decision). Resolves THIS file's own primary backend (Workstream C task
    C2), not a shared default -- a file relocated onto a non-default backend
    is still downloadable from wherever its bytes actually are. 409 if the
    file hasn't finished being stored yet (NULL ``verified_at`` and the
    backend object genuinely doesn't exist -- a NULL ``verified_at`` with an
    already-present object, e.g. a race with a scanner, is not treated as
    "processing").

    ``?member=gcode`` (R10-B): for a ``gcode_3mf`` blob, extracts and streams
    the embedded per-plate ``.gcode`` instead of the raw zip -- the
    frontend's ``GcodePreview`` needs a bare gcode stream, and re-deriving it
    at extraction time (rather than a new derivative/table) keeps the
    already-stored zip as the single source of truth.
    """
    file = await db.get(File, file_id)
    if file is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"file {file_id} not found")

    backend = await resolve_backend_for_file(db, settings, file)
    if file.verified_at is None:
        exists = await anyio.to_thread.run_sync(backend.exists, file.storage_path)
        if not exists:
            raise HTTPException(status.HTTP_409_CONFLICT, "file is still processing")

    blob = await db.get(Blob, file.blob_hash)

    if member == "gcode":
        if blob is None or blob.format is not BlobFormat.GCODE_3MF:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "member=gcode needs a gcode_3mf file")
        try:
            chunks = await anyio.to_thread.run_sync(lambda: list(backend.read(file.storage_path)))
        except StorageKeyNotFound as exc:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "file missing from storage") from exc
        data = b"".join(chunks)
        gcode_bytes = await anyio.to_thread.run_sync(_extract_embedded_gcode, data, plate)
        return StreamingResponse(
            iter((gcode_bytes,)),
            media_type="text/plain",
            headers={"Content-Length": str(len(gcode_bytes))},
        )

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
