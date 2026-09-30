"""Print-jobs history (SPEC "API surface": print-jobs; M4 Task 7). Read-only
DB listing/lookup -- no adapter/lib involved, so this stays behind the same
``require_printer_enabled`` 503 gate as ``app.api.printers`` (the history is
only meaningful while the printer feature is on).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_printer_enabled
from app.db import get_db
from app.models import BlobMeta, File, Model, PrintJob, Revision
from app.schemas.printers import PrintJobOut

router = APIRouter(
    prefix="/print-jobs", tags=["print-jobs"], dependencies=[Depends(require_printer_enabled)]
)


@router.get("", response_model=list[PrintJobOut])
async def list_print_jobs(
    printer_id: int | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
) -> list[PrintJobOut]:
    stmt = (
        select(PrintJob, File, Model, BlobMeta)
        .outerjoin(File, PrintJob.file_id == File.id)
        .outerjoin(Revision, File.revision_id == Revision.id)
        .outerjoin(Model, Revision.model_id == Model.id)
        .outerjoin(BlobMeta, File.blob_hash == BlobMeta.blob_hash)
        .order_by(PrintJob.id.desc())
        .limit(limit)
    )
    if printer_id is not None:
        stmt = stmt.where(PrintJob.printer_id == printer_id)
    rows = (await db.execute(stmt)).all()
    return [
        PrintJobOut.from_model(job, file=file, model=model, meta=meta)
        for job, file, model, meta in rows
    ]


@router.get("/{job_id}", response_model=PrintJobOut)
async def get_print_job(job_id: int, db: AsyncSession = Depends(get_db)) -> PrintJobOut:
    stmt = (
        select(PrintJob, File, Model, BlobMeta)
        .outerjoin(File, PrintJob.file_id == File.id)
        .outerjoin(Revision, File.revision_id == Revision.id)
        .outerjoin(Model, Revision.model_id == Model.id)
        .outerjoin(BlobMeta, File.blob_hash == BlobMeta.blob_hash)
        .where(PrintJob.id == job_id)
    )
    row = (await db.execute(stmt)).first()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "print job not found")
    job, file, model, meta = row
    return PrintJobOut.from_model(job, file=file, model=model, meta=meta)
