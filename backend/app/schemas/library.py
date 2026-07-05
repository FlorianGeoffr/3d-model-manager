"""Pydantic request/response schemas for the library domain (SPEC "API
surface", Task 5 brief). ``*.from_model`` classmethods map loaded ORM rows
(``app.models.library``) onto these flat response shapes.
"""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Annotated

from pydantic import BaseModel, StringConstraints

from app.models.enums import BlobFormat, BlobKind

if TYPE_CHECKING:
    from app.models.library import File, Note

# Empty/whitespace-only strings 422 (stripped before the min_length check),
# per Task 5's "empty-name model -> 422" interface decision.
NonEmptyStr = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


# -- models -------------------------------------------------------------


class ModelCreate(BaseModel):
    name: NonEmptyStr
    description: str | None = None


class ModelPatch(BaseModel):
    """All fields optional; only the ones present in the request body are
    applied (see ``model_dump(exclude_unset=True)`` in ``app.api.models``).
    Setting ``name`` never changes ``slug``/on-disk directories in M1.
    """

    name: NonEmptyStr | None = None
    description: str | None = None
    cover_blob_hash: str | None = None


class ModelSummary(BaseModel):
    """Gallery list item (Task 5 interface decision)."""

    id: int
    slug: str
    name: str
    description: str | None
    tags: list[str]
    updated_at: datetime
    created_at: datetime
    file_count: int
    formats: list[BlobFormat]
    cover: str | None = None


class GalleryPage(BaseModel):
    items: list[ModelSummary]
    next_cursor: str | None


# -- files / notes --------------------------------------------------------


class FileOut(BaseModel):
    id: int
    revision_id: int
    rel_path: str
    storage_path: str
    blob_hash: str
    size: int
    format: BlobFormat
    kind: BlobKind
    mtime: datetime | None
    verified_at: datetime | None

    @classmethod
    def from_model(cls, file: File) -> FileOut:
        return cls(
            id=file.id,
            revision_id=file.revision_id,
            rel_path=file.rel_path,
            storage_path=file.storage_path,
            blob_hash=file.blob_hash,
            size=file.blob.size,
            format=file.blob.format,
            kind=file.blob.kind,
            mtime=file.mtime,
            verified_at=file.verified_at,
        )


class NoteCreate(BaseModel):
    model_id: int
    revision_id: int | None = None
    body: NonEmptyStr


class NotePatch(BaseModel):
    body: NonEmptyStr


class NoteOut(BaseModel):
    id: int
    model_id: int
    revision_id: int | None
    body: str
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_model(cls, note: Note) -> NoteOut:
        return cls(
            id=note.id,
            model_id=note.model_id,
            revision_id=note.revision_id,
            body=note.body,
            created_at=note.created_at,
            updated_at=note.updated_at,
        )


# -- revisions --------------------------------------------------------


class RevisionCreate(BaseModel):
    name: str | None = None
    note: str | None = None


class RevisionSummary(BaseModel):
    id: int
    model_id: int
    number: int
    name: str | None
    note: str | None
    dir_name: str
    created_at: datetime
    file_count: int


class RevisionDetail(BaseModel):
    id: int
    model_id: int
    number: int
    name: str | None
    note: str | None
    dir_name: str
    created_at: datetime
    files: list[FileOut]
    notes: list[NoteOut]


class ModelDetail(BaseModel):
    id: int
    slug: str
    name: str
    description: str | None
    source_url: str | None
    source_site: str | None
    source_author: str | None
    source_license: str | None
    imported_at: datetime | None
    cover_blob_hash: str | None
    is_archived: bool
    created_at: datetime
    updated_at: datetime
    tags: list[str]
    current_revision: RevisionDetail | None
    notes: list[NoteOut]


# -- diff -------------------------------------------------------------


class DiffEntrySide(BaseModel):
    blob_hash: str
    size: int


class DiffEntry(BaseModel):
    rel_path: str
    a: DiffEntrySide | None
    b: DiffEntrySide | None


class DiffResponse(BaseModel):
    added: list[DiffEntry]
    removed: list[DiffEntry]
    changed: list[DiffEntry]
    unchanged: list[DiffEntry]


# -- tags -------------------------------------------------------------


class TagCreate(BaseModel):
    name: NonEmptyStr


class TagOut(BaseModel):
    id: int
    name: str
