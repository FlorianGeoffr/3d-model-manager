"""Bulk-seed the gallery for perf tests via direct Core inserts -- no
storage-backend side effects (mkdirs/sidecars) and no one-HTTP-call-per-model
(1000 sequential POSTs would dominate the wall clock). D1: no such helper
exists in the suite today.

IDs are assigned client-side (starting one past the current max in each
table) rather than relying on ``RETURNING``'s row order matching a
multi-row ``VALUES`` list -- PostgreSQL doesn't formally guarantee that
correlation, and this helper needs an exact model<->revision pairing to set
``models.current_revision_id``.
"""

from __future__ import annotations

import hashlib

from sqlalchemy import bindparam, func, insert, select, update
from sqlalchemy.orm import Session

from app.models import Blob, File, Model, Revision, Tag
from app.models.enums import BlobFormat, BlobKind
from app.models.library import model_tags
from app.models.processing import BlobMeta

_CHUNK = 500
# Cycled across seeded models so `format=stl` (and friends) has a
# representative, non-trivial fraction of matches rather than either all or
# none.
_FORMATS = (BlobFormat.STL, BlobFormat.THREEMF, BlobFormat.OBJ)


def _blob_hash(key: str) -> str:
    """A deterministic, unique 64-hex-char value fitting ``Blob.hash``'s
    ``CHAR(64)`` -- content doesn't matter for a seeded perf fixture."""
    return hashlib.sha256(key.encode()).hexdigest()


def _next_id(session: Session, table) -> int:
    current_max = session.execute(select(func.coalesce(func.max(table.c.id), 0))).scalar_one()
    return current_max + 1


def _bulk_insert(session: Session, table, rows: list[dict]) -> None:
    for start in range(0, len(rows), _CHUNK):
        chunk = rows[start : start + _CHUNK]
        if chunk:
            session.execute(insert(table).values(chunk))


def bulk_seed_models(session: Session, *, count: int, tags: int = 3, with_sliced: int = 0) -> None:
    """Seed ``count`` models, each with a rev-001 revision carrying one
    file/blob, ``tags`` shared ``Tag`` rows distributed round-robin across
    the models, and ``with_sliced`` of them carrying a sliced ``BlobMeta``
    (``print_time_s`` set) on their current revision's blob. Commits once at
    the end.
    """
    tag_start = _next_id(session, Tag.__table__)
    tag_ids = list(range(tag_start, tag_start + tags))
    _bulk_insert(session, Tag, [{"id": tid, "name": f"tag-{i}"} for i, tid in enumerate(tag_ids)])

    model_start = _next_id(session, Model.__table__)
    model_ids = list(range(model_start, model_start + count))
    _bulk_insert(
        session,
        Model,
        [
            {
                "id": mid,
                "slug": f"gallery-seed-{i:06d}",
                "name": f"Gallery Seed Model {i:06d}",
                "description": f"a bulk-seeded gallery perf fixture, number {i:06d}",
            }
            for i, mid in enumerate(model_ids)
        ],
    )

    revision_start = _next_id(session, Revision.__table__)
    revision_ids = list(range(revision_start, revision_start + count))
    _bulk_insert(
        session,
        Revision,
        [
            {
                "id": rid,
                "model_id": mid,
                "number": 1,
                "name": "initial",
                "dir_name": "rev-001_initial",
            }
            for rid, mid in zip(revision_ids, model_ids, strict=True)
        ],
    )

    blob_hashes = [_blob_hash(f"gallery-seed-blob-{i}") for i in range(count)]
    _bulk_insert(
        session,
        Blob,
        [
            {
                "hash": blob_hash,
                "size": 1024,
                "kind": BlobKind.MESH.value,
                "format": _FORMATS[i % len(_FORMATS)].value,
            }
            for i, blob_hash in enumerate(blob_hashes)
        ],
    )
    _bulk_insert(
        session,
        File,
        [
            {
                "revision_id": rid,
                "blob_hash": blob_hash,
                "rel_path": "part.stl",
                "storage_path": f"gallery-seed-{i:06d}/rev-001_initial/part.stl",
            }
            for i, (rid, blob_hash) in enumerate(zip(revision_ids, blob_hashes, strict=True))
        ],
    )

    if tag_ids:
        _bulk_insert(
            session,
            model_tags,
            [
                {"model_id": mid, "tag_id": tag_ids[i % len(tag_ids)]}
                for i, mid in enumerate(model_ids)
            ],
        )

    if with_sliced:
        _bulk_insert(
            session,
            BlobMeta,
            [
                {"blob_hash": blob_hash, "print_time_s": 3600 + i}
                for i, blob_hash in enumerate(blob_hashes[:with_sliced])
            ],
        )

    # Link each model to its own current revision -- a bulk (executemany-
    # style) Core UPDATE keyed by `id`, so correctness doesn't depend on any
    # insert-order assumption. Uses `Model.__table__` (plain Core) rather
    # than `update(Model)` -- the ORM-enabled form refuses to combine a bulk
    # executemany with an additional WHERE clause.
    session.execute(
        update(Model.__table__)
        .where(Model.__table__.c.id == bindparam("_id"))
        .values(current_revision_id=bindparam("_current_revision_id")),
        [
            {"_id": mid, "_current_revision_id": rid}
            for mid, rid in zip(model_ids, revision_ids, strict=True)
        ],
    )

    session.commit()
