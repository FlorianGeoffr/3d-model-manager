"""Raw-body streamed upload endpoint (SPEC "Upload flow", Task 6 interface
decisions): tees the body to blake3 + a spool file while it streams, then
upserts blob/file rows and enqueues ``store_to_backend`` to copy the spool
bytes onto the storage backend. The uploaded file is NOT yet on backend
storage when this returns -- ``verified_at`` stays NULL until the job
completes (see ``app.tasks.ingest.store_to_backend``).
"""

from __future__ import annotations

import uuid

import anyio
from blake3 import blake3
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.db import get_db
from app.schemas.uploads import UploadResult
from app.services import jobs as jobs_service
from app.services import library, spool
from app.services.layout import infer_blob_kind_format
from app.tasks.ingest import store_to_backend

router = APIRouter(tags=["uploads"])


@router.put("/uploads", status_code=status.HTTP_201_CREATED, response_model=UploadResult)
async def upload_file(
    request: Request,
    model_id: int,
    revision_id: int,
    rel_path: str,
    replace: bool = False,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> UploadResult:
    model, revision = await library.validate_upload_target(
        db, model_id=model_id, revision_id=revision_id, rel_path=rel_path, replace=replace
    )

    await anyio.to_thread.run_sync(spool.ensure_spool_dir, settings)
    token = uuid.uuid4()
    path = spool.spool_path(settings, token)

    # Any failure between here and the job dispatch below must not orphan
    # the spool file (once dispatched, the spool's lifecycle belongs to
    # store_to_backend: deleted on success, kept on failure for retry).
    try:
        hasher = blake3()
        size = 0
        fh = await anyio.to_thread.run_sync(path.open, "wb")
        try:
            async for chunk in request.stream():
                if not chunk:
                    continue
                hasher.update(chunk)
                size += len(chunk)
                await anyio.to_thread.run_sync(fh.write, chunk)
            await anyio.to_thread.run_sync(fh.flush)
        finally:
            await anyio.to_thread.run_sync(fh.close)

        if size == 0:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "empty upload body")

        blob_hash = hasher.hexdigest()
        kind, format_ = infer_blob_kind_format(rel_path)

        file = await library.finalize_upload(
            db,
            model=model,
            revision=revision,
            rel_path=rel_path,
            blob_hash=blob_hash,
            size=size,
            kind=kind,
            format_=format_,
            replace=replace,
        )

        job = await jobs_service.create_job(
            db, id=token, type="store_to_backend", subject_type="file", subject_id=file.id
        )
    except BaseException:
        await anyio.to_thread.run_sync(lambda: path.unlink(missing_ok=True))
        raise

    store_to_backend.apply_async(args=[str(job.id), file.id, str(path)], task_id=str(job.id))

    return UploadResult(file_id=file.id, blob_hash=blob_hash, size=size, job_id=job.id)
