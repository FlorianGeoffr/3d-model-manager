"""Duplicate-files report (Branch 4 Task 1): files sharing a blob hash
across more than one model -- surfaces reclaimable storage from the same
content having been imported/uploaded more than once.

Grouped over EVERY ``files`` row (every revision of every model, not just
current revisions) -- every row is bytes actually sitting on a storage
backend, so every row counts toward "wasted" storage regardless of which
revision it belongs to.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.library import Blob, File, Model, Revision
from app.schemas.reports import DuplicateFileOut, DuplicateGroupOut, DuplicatesReport


@dataclass(slots=True)
class _Bucket:
    size: int
    model_ids: set[int] = field(default_factory=set)
    files: list[DuplicateFileOut] = field(default_factory=list)


async def duplicate_files_report(db: AsyncSession) -> DuplicatesReport:
    stmt = (
        select(
            File.id,
            File.rel_path,
            File.blob_hash,
            Blob.size,
            Model.id,
            Model.slug,
            Model.name,
        )
        .join(Blob, Blob.hash == File.blob_hash)
        .join(Revision, Revision.id == File.revision_id)
        .join(Model, Model.id == Revision.model_id)
        .where(File.blob_hash.is_not(None))
    )
    rows = (await db.execute(stmt)).all()

    buckets: dict[str, _Bucket] = {}
    for file_id, rel_path, blob_hash, size, model_id, model_slug, model_name in rows:
        bucket = buckets.setdefault(blob_hash, _Bucket(size=size))
        bucket.model_ids.add(model_id)
        bucket.files.append(
            DuplicateFileOut(
                model_id=model_id,
                model_slug=model_slug,
                model_name=model_name,
                file_id=file_id,
                file_name=rel_path,
            )
        )

    groups = [
        DuplicateGroupOut(
            blob_hash=blob_hash,
            size=bucket.size,
            wasted_bytes=bucket.size * (len(bucket.files) - 1),
            files=sorted(bucket.files, key=lambda f: (f.model_id, f.file_id)),
        )
        for blob_hash, bucket in buckets.items()
        if len(bucket.model_ids) > 1
    ]
    groups.sort(key=lambda g: (-g.wasted_bytes, g.blob_hash))

    return DuplicatesReport(groups=groups, total_wasted_bytes=sum(g.wasted_bytes for g in groups))
