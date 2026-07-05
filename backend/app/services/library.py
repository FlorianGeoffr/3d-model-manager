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

from datetime import datetime
from pathlib import PurePosixPath

import anyio
from fastapi import HTTPException, status
from sqlalchemy import func, or_, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.enums import BlobFormat, BlobKind
from app.models.library import Blob, File, Model, Note, Revision, Tag, model_tags
from app.schemas.library import (
    DiffEntry,
    DiffEntrySide,
    DiffResponse,
    FileOut,
    ModelDetail,
    ModelSummary,
    NoteOut,
    RevisionDetail,
    RevisionSummary,
    TagOut,
)
from app.services import layout
from app.services.cursor import decode_cursor, encode_cursor
from app.storage.base import StorageBackend

_SORT_COLUMNS = {"updated_at": Model.updated_at, "name": Model.name}


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
    db: AsyncSession, backend: StorageBackend, *, name: str, description: str | None
) -> Model:
    slug = await _unique_slug(db, name)
    # `tags=[]` marks the relationship collection as already-loaded on this
    # (about to become persistent) instance -- without it, a bare
    # `model.tags` access later in the same request (build_model_detail)
    # would find the collection unloaded and try to lazy-load it, which
    # raises ``MissingGreenlet`` outside of an explicit ``await
    # session.execute(...)``-style call.
    model = Model(slug=slug, name=name, description=description, tags=[])
    db.add(model)
    await db.flush()  # assigns model.id, needed for the sidecar body

    revision = Revision(model_id=model.id, number=1, name="initial", dir_name="rev-001_initial")
    db.add(revision)
    await db.flush()

    def _write_storage() -> None:
        backend.mkdirs(layout.revision_dir_key(slug, revision.dir_name))
        layout.write_sidecar(backend, model.id, slug, model.name)

    await anyio.to_thread.run_sync(_write_storage)

    model.current_revision_id = revision.id
    await db.commit()
    return model


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


async def patch_model(db: AsyncSession, model: Model, changes: dict[str, object]) -> Model:
    """Apply ``changes`` (already ``exclude_unset``-filtered by the caller).

    ``name`` never touches ``slug``/on-disk directories in M1 (Task 5 brief).
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

    for field in ("name", "description", "cover_blob_hash"):
        if field in changes:
            setattr(model, field, changes[field])
    await db.commit()
    return model


async def archive_model(db: AsyncSession, model: Model) -> None:
    """Soft-delete: hard delete is out of M1 scope (Task 5 brief)."""
    model.is_archived = True
    await db.commit()


async def _gallery_aggregates(
    db: AsyncSession, revision_ids: list[int]
) -> dict[int, tuple[int, list[str]]]:
    """``{revision_id: (file_count, sorted distinct blob formats)}`` for the
    given (current) revision ids, computed in Python rather than
    Postgres-specific ``array_agg`` to keep this dialect-agnostic.
    """
    if not revision_ids:
        return {}
    rows = (
        await db.execute(
            select(File.revision_id, File.id, Blob.format)
            .join(Blob, Blob.hash == File.blob_hash)
            .where(File.revision_id.in_(revision_ids))
        )
    ).all()
    buckets: dict[int, dict[str, set]] = {}
    for revision_id, file_id, fmt in rows:
        bucket = buckets.setdefault(revision_id, {"file_ids": set(), "formats": set()})
        bucket["file_ids"].add(file_id)
        bucket["formats"].add(fmt)
    return {rid: (len(b["file_ids"]), sorted(b["formats"])) for rid, b in buckets.items()}


async def list_models(
    db: AsyncSession,
    *,
    q: str | None,
    tag: str | None,
    format_: str | None,
    sort: str,
    archived: bool,
    limit: int,
    cursor: str | None,
) -> tuple[list[ModelSummary], str | None]:
    """Gallery query: search/filter/sort + cursor pagination (Task 5
    interface decision).
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
        like = f"%{q}%"
        stmt = stmt.where(or_(Model.name.ilike(like), Model.description.ilike(like)))
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

    aggregates = await _gallery_aggregates(
        db, [m.current_revision_id for m in page_models if m.current_revision_id is not None]
    )

    items = [
        ModelSummary(
            id=m.id,
            slug=m.slug,
            name=m.name,
            description=m.description,
            tags=[t.name for t in m.tags],
            updated_at=m.updated_at,
            created_at=m.created_at,
            file_count=aggregates.get(m.current_revision_id, (0, []))[0],
            formats=aggregates.get(m.current_revision_id, (0, []))[1],
            cover=None,
        )
        for m in page_models
    ]

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
        .options(selectinload(Revision.files).selectinload(File.blob))
    )
    revision = (await db.execute(stmt)).scalar_one_or_none()
    if revision is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"revision {revision_id} not found")
    return revision


async def build_revision_detail(db: AsyncSession, revision: Revision) -> RevisionDetail:
    notes = await _list_notes(db, model_id=None, revision_id=revision.id)
    files = [FileOut.from_model(f) for f in sorted(revision.files, key=lambda f: f.rel_path)]
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


async def build_model_detail(db: AsyncSession, model: Model) -> ModelDetail:
    notes = await _list_notes(db, model_id=model.id, revision_id=None)
    current_revision = None
    if model.current_revision_id is not None:
        revision = await get_revision_or_404(db, model.current_revision_id)
        current_revision = await build_revision_detail(db, revision)
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

    new_revision = Revision(
        model_id=model.id, number=next_number, name=name, note=note, dir_name=dir_name
    )
    db.add(new_revision)
    await db.flush()

    old_files: list[File] = []
    if model.current_revision_id is not None:
        old_files = list(
            (
                await db.execute(select(File).where(File.revision_id == model.current_revision_id))
            ).scalars()
        )

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
        await db.flush()

    if replace:
        existing = (
            await db.execute(
                select(File).where(File.revision_id == revision.id, File.rel_path == rel_path)
            )
        ).scalar_one_or_none()
        if existing is not None:
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
    await db.commit()
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

    await anyio.to_thread.run_sync(backend.delete, file.storage_path)
    await db.delete(file)
    await db.commit()


# -- tags -------------------------------------------------------------


async def list_tags(db: AsyncSession) -> list[TagOut]:
    tags = (await db.execute(select(Tag).order_by(Tag.name))).scalars().all()
    return [TagOut(id=t.id, name=t.name) for t in tags]


async def add_tag_to_model(db: AsyncSession, model_id: int, name: str) -> TagOut:
    """Get-or-create the tag, then associate it with the model (idempotent)."""
    await get_model_by_id(db, model_id)

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
    await db.commit()
    return TagOut(id=tag.id, name=tag.name)


async def remove_tag_from_model(db: AsyncSession, model_id: int, name: str) -> None:
    await get_model_by_id(db, model_id)

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
