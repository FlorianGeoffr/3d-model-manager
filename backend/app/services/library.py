"""Library domain: models, revisions, files, tags, notes (SPEC "Data model",
"Storage layer", Task 5 brief).

Endpoints (``app/api/{models,revisions,tags,notes,files}.py``) stay thin --
this module owns DB queries, the storage-first-then-commit ordering, and
building the response schemas from loaded ORM rows.

Per Task 5's interface decision, storage side effects always run *before*
the DB commit for the same logical operation (create model, create
revision, delete file): if the storage op raises, the request fails and
nothing about it is committed (the ``get_db`` dependency's
``async with session:`` rolls back on the way out). Cross-request crash
consistency for storage ops that partially succeeded before a crash (e.g. a
directory or a few copied files with no matching committed rows) is left to
the scanner (SPEC M3 "Rescan/reconcile") -- not handled here.
"""

from __future__ import annotations

import contextlib
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from pathlib import PurePosixPath
from typing import TYPE_CHECKING, Literal

import anyio
from fastapi import HTTPException, status
from sqlalchemy import func, or_, select, tuple_
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session as SyncSession
from sqlalchemy.orm import selectinload

from app.config import Settings
from app.models.enums import BlobFormat, BlobKind, DerivativeKind, DerivativeStatus
from app.models.library import Blob, File, Model, Note, Revision, Tag, model_tags
from app.models.processing import AssemblyThumb, BlobMeta, Derivative
from app.models.system import Job
from app.schemas.library import (
    BlobMetaOut,
    DiffEntry,
    DiffEntrySide,
    DiffResponse,
    FileEnrichment,
    FileOut,
    ModelDetail,
    ModelSummary,
    NoteOut,
    PlateOut,
    RevisionDetail,
    RevisionSummary,
    TagOut,
)
from app.services import derivatives, layout
from app.services import jobs as jobs_service
from app.services.cursor import decode_cursor, encode_cursor
from app.storage.base import StorageBackend
from app.storage.errors import StorageKeyNotFound

if TYPE_CHECKING:
    # Avoids a runtime import cycle (app.importers.download doesn't import
    # this module, but keeping the dependency one-directional at runtime is
    # simplest): only needed for the `store_imported_file_sync` annotation.
    from app.importers.download import StagedFile

_SORT_COLUMNS = {"updated_at": Model.updated_at, "name": Model.name}

# Formats whose blobs get a `glb` derivative at all (Global Constraints
# "Pipeline shape" table) -- mirrors `app.tasks.pipeline`'s private
# `_MESH_FORMATS + _CAD_FORMATS`, duplicated here rather than imported to
# avoid a services -> tasks layering inversion (`app.tasks.pipeline` already
# imports `app.services.jobs`/`app.services.derivatives`).
_GLB_FORMATS = (
    BlobFormat.STL,
    BlobFormat.OBJ,
    BlobFormat.THREEMF,
    BlobFormat.STEP,
    BlobFormat.IGES,
)


# -- file enrichment (Task 7) ---------------------------------------------


def _derivative_ok(blob: Blob, kind: DerivativeKind) -> bool:
    return any(d.kind == kind and d.status == DerivativeStatus.OK for d in blob.derivatives)


def _glb_status(blob: Blob) -> Literal["ok", "pending", "failed", "unsupported"] | None:
    """``None`` when ``blob.format`` never produces a GLB at all; a missing
    row on a GLB-format blob is ``"pending"`` (Task 7 interface decision).
    """
    if blob.format not in _GLB_FORMATS:
        return None
    deriv = next((d for d in blob.derivatives if d.kind == DerivativeKind.GLB), None)
    if deriv is None:
        return "pending"
    return deriv.status.value


async def _build_file_enrichments(
    settings: Settings, blobs: Iterable[Blob]
) -> dict[str, FileEnrichment]:
    """``{blob_hash: FileEnrichment}`` for every DISTINCT blob among
    ``blobs`` (already ``selectinload``ed with ``.meta``/``.derivatives`` by
    the caller -- no extra DB queries here). The only filesystem access
    anywhere in this function is plate-thumbnail existence (plate PNGs are
    rowless, Global Constraints "Derivative store"): every plate path across
    every blob is batched into ONE ``anyio.to_thread.run_sync`` call rather
    than one per plate/file (Task 7 interface decision).
    """
    unique_blobs = {blob.hash: blob for blob in blobs}

    plate_paths: dict[tuple[str, int], object] = {}
    for blob_hash, blob in unique_blobs.items():
        raw_plates = (blob.meta.raw or {}).get("plates") if blob.meta is not None else None
        for plate in raw_plates or []:
            plate_paths[(blob_hash, plate["index"])] = derivatives.plate_thumb_path(
                settings, blob_hash, plate["index"]
            )

    def _check_existence() -> dict[tuple[str, int], bool]:
        return {key: path.exists() for key, path in plate_paths.items()}

    existence = await anyio.to_thread.run_sync(_check_existence) if plate_paths else {}

    enrichments: dict[str, FileEnrichment] = {}
    for blob_hash, blob in unique_blobs.items():
        meta_out = None
        if blob.meta is not None:
            raw_plates = (blob.meta.raw or {}).get("plates")
            plates_out = (
                [
                    PlateOut.from_raw(
                        plate, thumbnail_available=existence.get((blob_hash, plate["index"]), False)
                    )
                    for plate in raw_plates
                ]
                if raw_plates
                else None
            )
            meta_out = BlobMetaOut.from_model(blob.meta, plates_out)
        enrichments[blob_hash] = FileEnrichment(
            meta=meta_out,
            thumb_ready=_derivative_ok(blob, DerivativeKind.THUMB_256),
            glb_status=_glb_status(blob),
            glb_preview_ready=_derivative_ok(blob, DerivativeKind.GLB_PREVIEW),
        )
    return enrichments


# -- models -------------------------------------------------------------


async def _unique_slug(db: AsyncSession, name: str) -> str:
    """Base slug, uniquified with ``-2``, ``-3``, ... on collision."""
    base = layout.slug_for(name)
    slug = base
    suffix = 2
    while await db.scalar(select(Model.id).where(Model.slug == slug)) is not None:
        slug = f"{base}-{suffix}"
        suffix += 1
    return slug


async def create_model(
    db: AsyncSession,
    backend: StorageBackend,
    *,
    name: str,
    description: str | None,
    source_url: str | None = None,
    source_site: str | None = None,
    source_author: str | None = None,
    source_license: str | None = None,
    imported_at: datetime | None = None,
    initial_revision_name: str = "initial",
) -> Model:
    slug = await _unique_slug(db, name)
    # `tags=[]` marks the relationship collection as already-loaded on this
    # (about to become persistent) instance -- without it, a bare
    # `model.tags` access later in the same request (build_model_detail)
    # would find the collection unloaded and try to lazy-load it, which
    # raises ``MissingGreenlet`` outside of an explicit ``await
    # session.execute(...)``-style call.
    model = Model(
        slug=slug,
        name=name,
        description=description,
        tags=[],
        source_url=source_url,
        source_site=source_site,
        source_author=source_author,
        source_license=source_license,
        imported_at=imported_at,
    )
    db.add(model)
    await db.flush()  # assigns model.id, needed for the sidecar body

    dir_name = layout.revision_dir_name(1, initial_revision_name)
    revision = Revision(model_id=model.id, number=1, name=initial_revision_name, dir_name=dir_name)
    db.add(revision)
    await db.flush()

    def _write_storage() -> None:
        backend.mkdirs(layout.revision_dir_key(slug, revision.dir_name))
        layout.write_sidecar(backend, model.id, slug, model.name)

    await anyio.to_thread.run_sync(_write_storage)

    model.current_revision_id = revision.id
    await db.commit()
    return model


def _unique_slug_sync(session: SyncSession, name: str) -> str:
    base = layout.slug_for(name)
    slug = base
    suffix = 2
    while session.scalar(select(Model.id).where(Model.slug == slug)) is not None:
        slug = f"{base}-{suffix}"
        suffix += 1
    return slug


def create_imported_model_sync(
    session: SyncSession,
    backend: StorageBackend,
    *,
    name: str,
    description: str | None,
    source_url: str | None,
    source_site: str | None,
    source_author: str | None,
    source_license: str | None,
    imported_at: datetime | None,
    tags: list[str],
    initial_revision_name: str = "imported",
) -> Model:
    """SYNC twin of ``create_model`` for the import worker (app.tasks.base
    sync world). Inserts the Model + first revision WITH provenance, writes
    the storage sidecar, get-or-creates tag rows, and commits atomically --
    called only AFTER every file is staged to spool, so a Model row never
    exists for a failed import (Global Constraints "IMPORTS ATOMIC")."""
    slug = _unique_slug_sync(session, name)
    model = Model(
        slug=slug,
        name=name,
        description=description,
        tags=[],
        source_url=source_url,
        source_site=source_site,
        source_author=source_author,
        source_license=source_license,
        imported_at=imported_at,
    )
    session.add(model)
    session.flush()
    dir_name = layout.revision_dir_name(1, initial_revision_name)
    revision = Revision(model_id=model.id, number=1, name=initial_revision_name, dir_name=dir_name)
    session.add(revision)
    session.flush()
    backend.mkdirs(layout.revision_dir_key(slug, dir_name))
    layout.write_sidecar(backend, model.id, slug, model.name)
    for tag_name in tags:
        tag = session.scalar(select(Tag).where(Tag.name == tag_name))
        if tag is None:
            tag = Tag(name=tag_name)
            session.add(tag)
            session.flush()
        model.tags.append(tag)
    model.current_revision_id = revision.id
    session.commit()
    return model


def store_imported_file_sync(
    session: SyncSession, *, model: Model, revision: Revision, staged: StagedFile
) -> File:
    """The §3a ingest seam for one staged import file (SYNC twin of the
    ``finalize_upload`` + ``create_job`` + ``store_to_backend.apply_async``
    sequence ``PUT /uploads`` runs). Upserts the Blob by hash, inserts the
    File (verified_at NULL), then dispatches the SAME store_to_backend job a
    browser upload does -- so glb/thumbs run afterward via the normal
    pipeline. ``staged.token`` is the spool token AND the job id (so a retry
    re-finds the spool), mirroring ``app.api.uploads``."""
    from app.services import jobs as jobs_service
    from app.tasks.ingest import store_to_backend

    blob = session.get(Blob, staged.blob_hash)
    if blob is None:
        blob = Blob(
            hash=staged.blob_hash, size=staged.size, kind=staged.kind, format=staged.format_
        )
        session.add(blob)
        try:
            session.flush()
        except IntegrityError:
            session.rollback()
            blob = session.get(Blob, staged.blob_hash)  # concurrent insert of same content
    file = File(
        revision_id=revision.id,
        blob_hash=staged.blob_hash,
        rel_path=staged.rel_path,
        storage_path=layout.file_key(model.slug, revision.dir_name, staged.rel_path),
        verified_at=None,
    )
    session.add(file)
    session.commit()
    session.refresh(file)
    job = jobs_service.create_job_sync(
        session, id=staged.token, type="store_to_backend", subject_type="file", subject_id=file.id
    )
    store_to_backend.apply_async(
        args=[str(job.id), file.id, str(staged.spool_path)], task_id=str(job.id)
    )
    return file


async def get_model_by_id(db: AsyncSession, model_id: int) -> Model:
    model = await db.get(Model, model_id)
    if model is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"model {model_id} not found")
    return model


async def get_model_by_slug(db: AsyncSession, slug: str) -> Model:
    stmt = select(Model).where(Model.slug == slug).options(selectinload(Model.tags))
    model = (await db.execute(stmt)).scalar_one_or_none()
    if model is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"model {slug!r} not found")
    return model


async def patch_model(
    db: AsyncSession, backend: StorageBackend, model: Model, changes: dict[str, object]
) -> Model:
    """Apply ``changes`` (already ``exclude_unset``-filtered by the caller).

    ``name`` never touches ``slug``/on-disk directories in M1 (Task 5 brief),
    but DOES rewrite the ``.3dmm.json`` sidecar's ``name`` field (M3 carried
    backlog item: the sidecar used to go stale after a rename). ``review_state``
    is accepted here too so the UI can clear an adopted flag (M3 scanner note).
    Pre-validates ``cover_blob_hash`` if provided: must exist in blobs table.
    """
    # Pre-validate cover_blob_hash before applying changes
    if "cover_blob_hash" in changes:
        new_hash = changes["cover_blob_hash"]
        if new_hash is not None:  # None clears the cover; only validate non-None values
            blob = await db.get(Blob, new_hash)
            if blob is None:
                raise HTTPException(
                    status.HTTP_422_UNPROCESSABLE_CONTENT, detail="unknown cover_blob_hash"
                )

    new_name = changes.get("name")
    name_changing = "name" in changes and new_name != model.name
    if name_changing:
        # Storage side effect before the commit (module docstring's ordering
        # rule): if the sidecar write fails, the request fails and nothing
        # about it is committed.
        await anyio.to_thread.run_sync(
            layout.write_sidecar, backend, model.id, model.slug, new_name
        )

    for field in ("name", "description", "cover_blob_hash", "review_state"):
        if field in changes:
            setattr(model, field, changes[field])
    await db.commit()
    return model


async def archive_model(db: AsyncSession, model: Model) -> None:
    """Soft-delete: hard delete is out of M1 scope (Task 5 brief)."""
    model.is_archived = True
    await db.commit()


def _escape_like(value: str) -> str:
    """Escape ``\\``, ``%``, ``_`` so a user's ``q`` is matched literally by
    ``ILIKE`` rather than as a wildcard pattern (Task 7 backlog fold) -- e.g.
    a search for ``"100%"`` must not incidentally match every row containing
    plain ``"100"``. Paired with ``escape="\\\\"`` on the ``ilike()`` calls
    below.
    """
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


@dataclass(slots=True)
class _GalleryAggregate:
    """Per-(current-revision) batch of gallery fields, computed for a whole
    page at once (Task 7 brief: "FIXED number of queries per page, never
    per-model/per-file").
    """

    file_count: int
    formats: list[BlobFormat]
    has_sliced: bool
    print_time_s: int | None
    assembly_ok: bool
    first_ok_thumb_blob_hash: str | None


async def _gallery_aggregates(
    db: AsyncSession, page_models: list[Model]
) -> tuple[dict[int, _GalleryAggregate], set[str]]:
    """``({revision_id: _GalleryAggregate}, {ok-thumb cover_blob_hash})`` for
    ``page_models``'s current revisions -- three queries total for the whole
    page (file/format/print-time/thumb-ok join, assembly-thumb-ok set,
    cover-blob-ok set), never one per model or per file.
    """
    revision_ids = [m.current_revision_id for m in page_models if m.current_revision_id is not None]
    if not revision_ids:
        return {}, set()

    rows = (
        await db.execute(
            select(
                File.revision_id,
                File.id,
                File.rel_path,
                File.blob_hash,
                Blob.format,
                BlobMeta.print_time_s,
                Derivative.id,
            )
            .join(Blob, Blob.hash == File.blob_hash)
            .outerjoin(BlobMeta, BlobMeta.blob_hash == File.blob_hash)
            .outerjoin(
                Derivative,
                (Derivative.blob_hash == File.blob_hash)
                & (Derivative.kind == DerivativeKind.THUMB_256)
                & (Derivative.status == DerivativeStatus.OK),
            )
            .where(File.revision_id.in_(revision_ids))
        )
    ).all()

    buckets: dict[int, dict] = {}
    for revision_id, file_id, rel_path, blob_hash, fmt, print_time_s, thumb_ok_id in rows:
        bucket = buckets.setdefault(
            revision_id,
            {"file_ids": set(), "formats": set(), "print_times": [], "thumb_files": []},
        )
        bucket["file_ids"].add(file_id)
        bucket["formats"].add(fmt)
        if print_time_s is not None:
            bucket["print_times"].append(print_time_s)
        bucket["thumb_files"].append((rel_path, blob_hash, thumb_ok_id is not None))

    assembly_ok_revision_ids = set(
        (
            await db.execute(
                select(AssemblyThumb.revision_id).where(
                    AssemblyThumb.revision_id.in_(revision_ids),
                    AssemblyThumb.status == DerivativeStatus.OK,
                )
            )
        ).scalars()
    )

    cover_hashes = {m.cover_blob_hash for m in page_models if m.cover_blob_hash is not None}
    cover_ok_hashes: set[str] = set()
    if cover_hashes:
        cover_ok_hashes = set(
            (
                await db.execute(
                    select(Derivative.blob_hash).where(
                        Derivative.blob_hash.in_(cover_hashes),
                        Derivative.kind == DerivativeKind.THUMB_256,
                        Derivative.status == DerivativeStatus.OK,
                    )
                )
            ).scalars()
        )

    aggregates: dict[int, _GalleryAggregate] = {}
    for revision_id, bucket in buckets.items():
        first_ok_thumb = next(
            (
                blob_hash
                for _, blob_hash, ok in sorted(bucket["thumb_files"], key=lambda t: t[0])
                if ok
            ),
            None,
        )
        aggregates[revision_id] = _GalleryAggregate(
            file_count=len(bucket["file_ids"]),
            formats=sorted(bucket["formats"]),
            has_sliced=bool(bucket["print_times"]),
            print_time_s=min(bucket["print_times"]) if bucket["print_times"] else None,
            assembly_ok=revision_id in assembly_ok_revision_ids,
            first_ok_thumb_blob_hash=first_ok_thumb,
        )
    return aggregates, cover_ok_hashes


def _gallery_cover_url(
    model: Model, aggregate: _GalleryAggregate | None, cover_ok_hashes: set[str]
) -> str | None:
    """Cover priority chain (Task 7 interface decision): the model's own
    ``cover_blob_hash`` (if its thumb is ready) beats the revision's
    assembly thumbnail (if ready) beats the first (by ``rel_path``) file
    with a ready thumb; ``None`` if nothing is ready yet.
    """
    if model.cover_blob_hash is not None and model.cover_blob_hash in cover_ok_hashes:
        return f"/api/blobs/{model.cover_blob_hash}/thumb?size=256"
    if aggregate is not None and aggregate.assembly_ok:
        return f"/api/revisions/{model.current_revision_id}/assembly-thumb"
    if aggregate is not None and aggregate.first_ok_thumb_blob_hash is not None:
        return f"/api/blobs/{aggregate.first_ok_thumb_blob_hash}/thumb?size=256"
    return None


async def list_models(
    db: AsyncSession,
    *,
    q: str | None,
    tag: str | None,
    format_: str | None,
    has_sliced: bool | None,
    sort: str,
    archived: bool,
    limit: int,
    cursor: str | None,
) -> tuple[list[ModelSummary], str | None]:
    """Gallery query: search/filter/sort + cursor pagination (Task 5
    interface decision; Task 7 adds the ``has_sliced`` filter).
    """
    is_desc = sort.startswith("-")
    field_name = sort[1:] if is_desc else sort
    sort_column = _SORT_COLUMNS.get(field_name)
    if sort_column is None:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"invalid sort field: {field_name!r}")

    stmt = select(Model).options(selectinload(Model.tags))
    if not archived:
        stmt = stmt.where(Model.is_archived.is_(False))
    if q:
        like = f"%{_escape_like(q)}%"
        stmt = stmt.where(
            or_(
                Model.name.ilike(like, escape="\\"),
                Model.description.ilike(like, escape="\\"),
            )
        )
    if tag:
        stmt = stmt.where(
            Model.id.in_(
                select(model_tags.c.model_id)
                .join(Tag, Tag.id == model_tags.c.tag_id)
                .where(Tag.name == tag)
            )
        )
    if format_:
        stmt = stmt.where(
            Model.current_revision_id.in_(
                select(File.revision_id)
                .join(Blob, Blob.hash == File.blob_hash)
                .where(Blob.format == format_)
            )
        )
    if has_sliced is not None:
        sliced_revision_ids = (
            select(File.revision_id)
            .join(BlobMeta, BlobMeta.blob_hash == File.blob_hash)
            .where(BlobMeta.print_time_s.is_not(None))
        )
        stmt = stmt.where(
            Model.current_revision_id.in_(sliced_revision_ids)
            if has_sliced
            else Model.current_revision_id.not_in(sliced_revision_ids)
        )

    order_col = sort_column.desc() if is_desc else sort_column.asc()
    order_id = Model.id.desc() if is_desc else Model.id.asc()
    stmt = stmt.order_by(order_col, order_id)

    if cursor:
        cursor_raw, cursor_id = decode_cursor(cursor)
        cursor_value: object
        if field_name == "updated_at":
            try:
                cursor_value = datetime.fromisoformat(cursor_raw)
            except ValueError as exc:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid cursor") from exc
        else:
            cursor_value = cursor_raw
        keyset = tuple_(sort_column, Model.id)
        cursor_tuple = tuple_(cursor_value, cursor_id)
        stmt = stmt.where(keyset < cursor_tuple if is_desc else keyset > cursor_tuple)

    stmt = stmt.limit(limit + 1)
    page_models = list((await db.execute(stmt)).scalars().unique().all())

    has_more = len(page_models) > limit
    page_models = page_models[:limit]

    aggregates, cover_ok_hashes = await _gallery_aggregates(db, page_models)

    items = []
    for m in page_models:
        agg = aggregates.get(m.current_revision_id)
        items.append(
            ModelSummary(
                id=m.id,
                slug=m.slug,
                name=m.name,
                description=m.description,
                tags=[t.name for t in m.tags],
                updated_at=m.updated_at,
                created_at=m.created_at,
                file_count=agg.file_count if agg else 0,
                formats=agg.formats if agg else [],
                cover=_gallery_cover_url(m, agg, cover_ok_hashes),
                print_time_s=agg.print_time_s if agg else None,
                has_sliced=agg.has_sliced if agg else False,
                source_site=m.source_site,
            )
        )

    next_cursor = None
    if has_more and page_models:
        last = page_models[-1]
        sort_value = last.updated_at.isoformat() if field_name == "updated_at" else last.name
        next_cursor = encode_cursor(sort_value, last.id)

    return items, next_cursor


# -- notes (shared helper for model/revision details) --------------------


async def _list_notes(
    db: AsyncSession, *, model_id: int | None, revision_id: int | None
) -> list[NoteOut]:
    stmt = select(Note).order_by(Note.created_at)
    if revision_id is not None:
        stmt = stmt.where(Note.revision_id == revision_id)
    else:
        stmt = stmt.where(Note.model_id == model_id, Note.revision_id.is_(None))
    notes = (await db.execute(stmt)).scalars().all()
    return [NoteOut.from_model(n) for n in notes]


# -- revisions --------------------------------------------------------


async def get_revision_or_404(db: AsyncSession, revision_id: int) -> Revision:
    stmt = (
        select(Revision)
        .where(Revision.id == revision_id)
        .options(
            # Two separate paths (not one chained loader) since `Blob.meta`/
            # `Blob.derivatives` are independent relationships off the same
            # `Blob` -- `build_revision_detail`'s `FileOut` enrichment needs
            # both, batched here rather than lazy-loaded per file.
            selectinload(Revision.files).selectinload(File.blob).selectinload(Blob.meta),
            selectinload(Revision.files).selectinload(File.blob).selectinload(Blob.derivatives),
        )
    )
    revision = (await db.execute(stmt)).scalar_one_or_none()
    if revision is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"revision {revision_id} not found")
    return revision


async def build_revision_detail(
    db: AsyncSession, revision: Revision, settings: Settings
) -> RevisionDetail:
    notes = await _list_notes(db, model_id=None, revision_id=revision.id)
    sorted_files = sorted(revision.files, key=lambda f: f.rel_path)
    enrichments = await _build_file_enrichments(settings, (f.blob for f in sorted_files))
    files = [FileOut.from_model(f, enrichments.get(f.blob_hash)) for f in sorted_files]
    return RevisionDetail(
        id=revision.id,
        model_id=revision.model_id,
        number=revision.number,
        name=revision.name,
        note=revision.note,
        dir_name=revision.dir_name,
        created_at=revision.created_at,
        files=files,
        notes=notes,
    )


async def build_model_detail(db: AsyncSession, model: Model, settings: Settings) -> ModelDetail:
    notes = await _list_notes(db, model_id=model.id, revision_id=None)
    current_revision = None
    if model.current_revision_id is not None:
        revision = await get_revision_or_404(db, model.current_revision_id)
        current_revision = await build_revision_detail(db, revision, settings)
    return ModelDetail(
        id=model.id,
        slug=model.slug,
        name=model.name,
        description=model.description,
        source_url=model.source_url,
        source_site=model.source_site,
        source_author=model.source_author,
        source_license=model.source_license,
        imported_at=model.imported_at,
        cover_blob_hash=model.cover_blob_hash,
        is_archived=model.is_archived,
        created_at=model.created_at,
        updated_at=model.updated_at,
        tags=[t.name for t in model.tags],
        current_revision=current_revision,
        notes=notes,
    )


async def list_revisions(db: AsyncSession, model: Model) -> list[RevisionSummary]:
    stmt = (
        select(Revision, func.count(File.id))
        .outerjoin(File, File.revision_id == Revision.id)
        .where(Revision.model_id == model.id)
        .group_by(Revision.id)
        .order_by(Revision.number)
    )
    rows = (await db.execute(stmt)).all()
    return [
        RevisionSummary(
            id=r.id,
            model_id=r.model_id,
            number=r.number,
            name=r.name,
            note=r.note,
            dir_name=r.dir_name,
            created_at=r.created_at,
            file_count=count,
        )
        for r, count in rows
    ]


async def create_revision(
    db: AsyncSession,
    backend: StorageBackend,
    model: Model,
    *,
    name: str | None,
    note: str | None,
) -> Revision:
    """Full-snapshot-copy the current revision's files into a new revision
    (SPEC "Storage layer" -> "New revision"): mkdirs -> ``backend.copy()``
    each file, reusing blob hashes (no re-hash) -> insert ``files`` rows ->
    bump ``current_revision_id``.
    """
    max_number = await db.scalar(
        select(func.max(Revision.number)).where(Revision.model_id == model.id)
    )
    next_number = (max_number or 0) + 1
    dir_name = layout.revision_dir_name(next_number, name)

    old_files: list[File] = []
    if model.current_revision_id is not None:
        old_files = list(
            (
                await db.execute(select(File).where(File.revision_id == model.current_revision_id))
            ).scalars()
        )

    # Pre-check BEFORE creating the new revision row or touching disk:
    # `backend.copy()` on a file whose store job hasn't settled raises
    # `StorageKeyNotFound` (the source object may not exist yet), which would
    # otherwise surface as a raw 500 after the new revision directory and
    # however many files had already been copied were left behind as storage
    # debris. Fail the whole snapshot up front instead.
    for old_file in old_files:
        if await _file_store_pending(db, old_file):
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                "files in the current revision are still processing; retry once stored",
            )

    new_revision = Revision(
        model_id=model.id, number=next_number, name=name, note=note, dir_name=dir_name
    )
    db.add(new_revision)
    await db.flush()

    def _snapshot_copy() -> None:
        backend.mkdirs(layout.revision_dir_key(model.slug, dir_name))
        for old_file in old_files:
            new_key = layout.file_key(model.slug, dir_name, old_file.rel_path)
            backend.copy(old_file.storage_path, new_key)

    await anyio.to_thread.run_sync(_snapshot_copy)

    for old_file in old_files:
        db.add(
            File(
                revision_id=new_revision.id,
                blob_hash=old_file.blob_hash,
                rel_path=old_file.rel_path,
                storage_path=layout.file_key(model.slug, dir_name, old_file.rel_path),
                # Unverified until a scan (SPEC "Rescan/reconcile") touches
                # it -- the copy itself is trusted, but nothing has stat'd
                # the resulting file yet.
                verified_at=None,
            )
        )

    model.current_revision_id = new_revision.id
    await db.commit()

    # Local import: app.tasks.pipeline imports app.services.jobs (for the
    # mark_*/create_job_sync helpers), so importing it back at module level
    # here would risk a circular import -- same reasoning as
    # `app.services.jobs`'s own local imports of `app.tasks.pipeline`/
    # `app.tasks.ingest`. Every blob in the snapshot is already converted (it
    # was copied from the previous, presumably-processed revision), or the
    # readiness check just declines -- either way this can't fail the
    # request (Task 6 interface decision: best-effort).
    from app.tasks.pipeline import maybe_enqueue_assembly_async

    await maybe_enqueue_assembly_async(db, revision_id=new_revision.id)

    return await get_revision_or_404(db, new_revision.id)


def _diff_side(file: File | None) -> DiffEntrySide | None:
    if file is None:
        return None
    return DiffEntrySide(blob_hash=file.blob_hash, size=file.blob.size)


async def diff_revisions(db: AsyncSession, revision_a_id: int, revision_b_id: int) -> DiffResponse:
    """Full outer join on ``rel_path`` between two revisions of the SAME
    model, comparing ``blob_hash`` (SPEC "Data model": "Revision diff").
    """
    revision_a = await get_revision_or_404(db, revision_a_id)
    revision_b = await get_revision_or_404(db, revision_b_id)
    if revision_a.model_id != revision_b.model_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "revisions belong to different models")

    files_a = {f.rel_path: f for f in revision_a.files}
    files_b = {f.rel_path: f for f in revision_b.files}

    added: list[DiffEntry] = []
    removed: list[DiffEntry] = []
    changed: list[DiffEntry] = []
    unchanged: list[DiffEntry] = []

    for rel_path in sorted(set(files_a) | set(files_b)):
        file_a = files_a.get(rel_path)
        file_b = files_b.get(rel_path)
        entry = DiffEntry(rel_path=rel_path, a=_diff_side(file_a), b=_diff_side(file_b))
        if file_a is None:
            added.append(entry)
        elif file_b is None:
            removed.append(entry)
        elif file_a.blob_hash == file_b.blob_hash:
            unchanged.append(entry)
        else:
            changed.append(entry)

    return DiffResponse(added=added, removed=removed, changed=changed, unchanged=unchanged)


# -- files --------------------------------------------------------------


def _validate_rel_path(rel_path: str) -> None:
    """Reject ``rel_path`` values that would produce an unsafe storage key.

    ``rel_path`` is user input that gets embedded into the file's storage
    key (``<slug>/<dir_name>/<rel_path>``). The storage backend would also
    reject these keys (``LocalStorageBackend._resolve``), but only later,
    inside the Celery task -- by which point a poisoned ``files`` row is
    already committed. Mirror the backend's key rules up front instead:
    no empty/dot paths, no backslashes, no absolute paths, no ``..``.
    """
    pure = PurePosixPath(rel_path)
    if (
        not rel_path
        or "\\" in rel_path
        or pure.is_absolute()
        or pure.parts == ()
        or ".." in pure.parts
    ):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"unsafe rel_path: {rel_path!r}")


async def _file_store_pending(db: AsyncSession, file: File) -> bool:
    """Whether ``file``'s ``store_to_backend`` job hasn't settled yet -- i.e.
    its bytes on the storage backend could still change out from under a
    caller. Shared by every operation that touches a file's on-backend bytes
    off the back of a DB read (upload-replace, delete, revision-snapshot
    copy) so they all tell the same 409 story instead of three slightly
    different ones.

    ``verified_at IS NULL`` alone isn't a safe signal: it also stays NULL
    forever after a job permanently fails (e.g. hash mismatch) or is
    superseded, and neither of those has a live job left to race. Only NULL
    ``verified_at`` *combined with* the file's most recent job still being
    queued/running means "something may still write to this key".
    """
    if file.verified_at is not None:
        return False
    latest_state = await db.scalar(
        select(Job.state)
        .where(Job.subject_type == "file", Job.subject_id == file.id)
        .order_by(Job.created_at.desc())
        .limit(1)
    )
    return latest_state in (jobs_service.STATE_QUEUED, jobs_service.STATE_RUNNING)


async def validate_upload_target(
    db: AsyncSession, *, model_id: int, revision_id: int, rel_path: str, replace: bool
) -> tuple[Model, Revision]:
    """Pre-flight checks for ``PUT /api/uploads``, run BEFORE the request
    body is read (Task 6 interface decision: fail fast rather than making
    the client upload bytes for a request that's going to 404/409 anyway).
    """
    _validate_rel_path(rel_path)
    model = await get_model_by_id(db, model_id)
    revision = await db.get(Revision, revision_id)
    if revision is None or revision.model_id != model.id:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"revision {revision_id} not found on model {model_id}"
        )
    if model.current_revision_id != revision.id:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "uploads are only allowed on the model's current revision",
        )
    existing = await db.scalar(
        select(File.id).where(File.revision_id == revision.id, File.rel_path == rel_path)
    )
    if existing is not None and not replace:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"rel_path {rel_path!r} already exists on this revision; pass replace=true",
        )
    return model, revision


async def finalize_upload(
    db: AsyncSession,
    *,
    model: Model,
    revision: Revision,
    rel_path: str,
    blob_hash: str,
    size: int,
    kind: BlobKind,
    format_: BlobFormat,
    replace: bool,
) -> File:
    """Upsert the ``Blob`` by hash (dedupe) and create/replace the ``File``
    row once the upload's bytes are fully spooled and hashed (Task 6
    interface decision). The bytes themselves aren't on backend storage yet
    -- ``verified_at`` stays NULL until ``store_to_backend`` (enqueued by the
    caller right after this) succeeds. ``replace=True`` deletes the old
    ``File`` row; ``storage_path`` is rel_path-derived so the new file's
    backend write naturally overwrites the same object regardless of
    content.
    """
    blob = await db.get(Blob, blob_hash)
    if blob is None:
        blob = Blob(hash=blob_hash, size=size, kind=kind, format=format_)
        db.add(blob)
        try:
            await db.flush()
        except IntegrityError:
            # Lost a race with a concurrent upload of the SAME content: the
            # other request's insert of this blob's PK committed in between
            # our `db.get` miss and this flush (Task 6 review finding). The
            # simpler of the two fixes considered (retry the lookup vs. map
            # to a clear 409) -- retrying would need its own error handling
            # for yet another concurrent delete/insert, for a benign,
            # rare-in-practice race. 409 is honest: the client's upload
            # didn't land as a new blob, but the caller can safely just
            # retry the whole upload.
            await db.rollback()
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                f"blob {blob_hash!r} is being uploaded concurrently; retry",
            ) from None

    if replace:
        existing = (
            await db.execute(
                select(File).where(File.revision_id == revision.id, File.rel_path == rel_path)
            )
        ).scalar_one_or_none()
        if existing is not None:
            if await _file_store_pending(db, existing):
                # The file being replaced hasn't finished its own store job
                # yet: deleting its row now and dispatching a new job for the
                # same rel_path lets the two jobs' `backend.write`s race each
                # other on disk, with whichever `os.replace` lands last
                # winning regardless of which job the DB says is "verified".
                # Reject outright instead -- the client can retry once the
                # in-flight job settles.
                raise HTTPException(
                    status.HTTP_409_CONFLICT,
                    f"rel_path {rel_path!r} is still processing; retry once stored",
                )
            await db.delete(existing)
            await db.flush()

    file = File(
        revision_id=revision.id,
        blob_hash=blob_hash,
        rel_path=rel_path,
        storage_path=layout.file_key(model.slug, revision.dir_name, rel_path),
        verified_at=None,
    )
    db.add(file)
    # Backlog fold: touch the model's `updated_at` so it sorts correctly in
    # the gallery's default `-updated_at` order. The column's own
    # `onupdate=func.now()` only fires when an UPDATE is actually issued for
    # THIS model row -- an upload never otherwise changes any `models`
    # column, so without this explicit touch the row would never get one.
    model.updated_at = func.now()
    try:
        await db.commit()
    except IntegrityError:
        # Lost a race with a concurrent upload to the same (revision_id,
        # rel_path): `validate_upload_target`'s pre-flight check ran before
        # the request body was read, so two concurrent uploads can both pass
        # it and then both reach here (Task 6 review finding). The
        # UniqueConstraint on `files` is the actual source of truth; the
        # loser gets the same 409 detail the pre-flight check would have
        # raised had it lost the race instead of winning it, rather than an
        # unhandled IntegrityError surfacing as a 500.
        await db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"rel_path {rel_path!r} already exists on this revision; pass replace=true",
        ) from None
    await db.refresh(file)
    return file


async def delete_file(db: AsyncSession, backend: StorageBackend, file_id: int) -> None:
    """File ops apply only to the model's CURRENT revision (Task 5 brief);
    409 otherwise.
    """
    file = await db.get(File, file_id)
    if file is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"file {file_id} not found")
    revision = await db.get(Revision, file.revision_id)
    assert revision is not None  # FK guarantees this
    model = await db.get(Model, revision.model_id)
    assert model is not None  # FK guarantees this
    if model.current_revision_id != file.revision_id:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "file belongs to a revision that is not the model's current revision",
        )
    if await _file_store_pending(db, file):
        # Deleting a row whose store job is still in flight would race
        # `store_to_backend`'s own writes -- reject rather than remove a row
        # the ingest task might still be about to touch.
        raise HTTPException(status.HTTP_409_CONFLICT, "file is still processing; retry once stored")

    # Already absent from the backend (e.g. the write never landed, or a
    # previous delete attempt crashed after removing the object but before
    # this commit) is tolerated, not an error: treating it as one would
    # permanently block deleting a `files` row whose object doesn't exist.
    # The DB row is what "should this file exist" actually means here, so a
    # missing backend object is just as good as a successful delete.
    with contextlib.suppress(StorageKeyNotFound):
        await anyio.to_thread.run_sync(backend.delete, file.storage_path)
    revision_id = revision.id
    await db.delete(file)
    # Backlog fold: see `finalize_upload`'s matching comment -- deleting a
    # file never otherwise issues an UPDATE against `models`.
    model.updated_at = func.now()
    await db.commit()

    # Local import: breaks the same import cycle as `create_revision`'s call
    # above (see that comment). The revision's composition just changed --
    # re-check whether it's now ready for an assembly render.
    from app.tasks.pipeline import maybe_enqueue_assembly_async

    await maybe_enqueue_assembly_async(db, revision_id=revision_id)


# -- tags -------------------------------------------------------------


async def list_tags(db: AsyncSession) -> list[TagOut]:
    tags = (await db.execute(select(Tag).order_by(Tag.name))).scalars().all()
    return [TagOut(id=t.id, name=t.name) for t in tags]


async def add_tag_to_model(db: AsyncSession, model_id: int, name: str) -> TagOut:
    """Get-or-create the tag, then associate it with the model (idempotent)."""
    model = await get_model_by_id(db, model_id)

    tag = (await db.execute(select(Tag).where(Tag.name == name))).scalar_one_or_none()
    if tag is None:
        tag = Tag(name=name)
        db.add(tag)
        await db.flush()

    already_linked = await db.scalar(
        select(model_tags.c.model_id).where(
            model_tags.c.model_id == model_id, model_tags.c.tag_id == tag.id
        )
    )
    if already_linked is None:
        await db.execute(model_tags.insert().values(model_id=model_id, tag_id=tag.id))
        # Backlog fold: see `finalize_upload`'s matching comment -- tagging
        # never otherwise issues an UPDATE against `models`. Only on an
        # actual new link, not the idempotent no-op re-tag.
        model.updated_at = func.now()
    await db.commit()
    return TagOut(id=tag.id, name=tag.name)


async def remove_tag_from_model(db: AsyncSession, model_id: int, name: str) -> None:
    model = await get_model_by_id(db, model_id)

    tag = (await db.execute(select(Tag).where(Tag.name == name))).scalar_one_or_none()
    if tag is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"tag {name!r} not found")

    result = await db.execute(
        model_tags.delete().where(model_tags.c.model_id == model_id, model_tags.c.tag_id == tag.id)
    )
    if result.rowcount == 0:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"tag {name!r} is not attached to model {model_id}"
        )
    model.updated_at = func.now()
    await db.commit()


# -- notes (CRUD) -------------------------------------------------------


async def create_note(
    db: AsyncSession, *, model_id: int, revision_id: int | None, body: str
) -> NoteOut:
    model = await get_model_by_id(db, model_id)
    if revision_id is not None:
        revision = await db.get(Revision, revision_id)
        if revision is None or revision.model_id != model.id:
            raise HTTPException(
                status.HTTP_404_NOT_FOUND,
                f"revision {revision_id} not found on model {model_id}",
            )
    note = Note(model_id=model_id, revision_id=revision_id, body=body)
    db.add(note)
    await db.commit()
    return NoteOut.from_model(note)


async def _get_note_or_404(db: AsyncSession, note_id: int) -> Note:
    note = await db.get(Note, note_id)
    if note is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"note {note_id} not found")
    return note


async def patch_note(db: AsyncSession, note_id: int, body: str) -> NoteOut:
    note = await _get_note_or_404(db, note_id)
    note.body = body
    await db.commit()
    return NoteOut.from_model(note)


async def delete_note(db: AsyncSession, note_id: int) -> None:
    note = await _get_note_or_404(db, note_id)
    await db.delete(note)
    await db.commit()
