"""Core library domain: models, tags, notes, revisions, blobs, files.

Principle (SPEC "Data model"): ``blobs`` are content identity (blake3 hash
PK); ``files`` are a path within a revision snapshot pointing at a blob.
"""

from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    CHAR,
    BigInteger,
    Boolean,
    Column,
    ForeignKey,
    Identity,
    Index,
    Integer,
    String,
    Table,
    Text,
    UniqueConstraint,
    false,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, str_enum
from app.models.enums import BlobFormat, BlobKind

if TYPE_CHECKING:
    # Only for static analysis / the `Mapped[...]` string annotations below
    # -- `Blob.meta`/`Blob.derivatives` resolve these by class name via
    # SQLAlchemy's registry at mapper-configure time (both modules are
    # imported together via `app.models`), not via this import.
    from app.models.processing import BlobMeta, Derivative

# Pure many-to-many join table (SPEC: ``model_tags(model_id, tag_id)``) --
# no extra columns, so a plain Core Table (used via ``relationship(secondary=...)``)
# is a better fit than a mapped class.
model_tags = Table(
    "model_tags",
    Base.metadata,
    Column("model_id", BigInteger, ForeignKey("models.id", ondelete="CASCADE"), primary_key=True),
    Column("tag_id", BigInteger, ForeignKey("tags.id", ondelete="CASCADE"), primary_key=True),
)
# Only the composite PK (model_id, tag_id) exists otherwise -- the gallery's
# `tag=` filter looks up by `tag_id` alone (Task 7 brief D1).
Index("ix_model_tags_tag_id", model_tags.c.tag_id)


class Model(Base):
    """A library model (SPEC ``models``)."""

    __tablename__ = "models"
    __table_args__ = (
        # pg_trgm GIN indexes backing gallery search (SPEC: "pg_trgm GIN on
        # models.name/description").
        Index(
            "ix_models_name_trgm",
            "name",
            postgresql_using="gin",
            postgresql_ops={"name": "gin_trgm_ops"},
        ),
        Index(
            "ix_models_description_trgm",
            "description",
            postgresql_using="gin",
            postgresql_ops={"description": "gin_trgm_ops"},
        ),
        # Gallery keyset-pagination indexes (Task 7 brief D1): back the
        # `sort=name` and default `-updated_at` keyset predicates
        # (`WHERE (sort_col, id) > (cursor_val, cursor_id) ORDER BY sort_col,
        # id`) with a composite index instead of a full sort.
        Index("ix_models_name_id", "name", "id"),
        Index("ix_models_updated_at_id", "updated_at", "id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    slug: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    source_url: Mapped[str | None] = mapped_column(Text)
    source_site: Mapped[str | None] = mapped_column(String)
    source_author: Mapped[str | None] = mapped_column(String)
    source_license: Mapped[str | None] = mapped_column(String)
    imported_at: Mapped[datetime | None]
    # Circular FK with revisions.model_id -> models.id: use_alter=True lets
    # SQLAlchemy (and Alembic autogenerate) create both tables first and add
    # this constraint afterwards, avoiding a table-creation-order deadlock.
    current_revision_id: Mapped[int | None] = mapped_column(
        BigInteger,
        ForeignKey("revisions.id", use_alter=True, name="fk_models_current_revision_id_revisions"),
    )
    cover_blob_hash: Mapped[str | None] = mapped_column(
        CHAR(64), ForeignKey("blobs.hash", ondelete="SET NULL")
    )
    # NULL = normal; "adopted" = the scanner attached this model out-of-band
    # and it hasn't been reviewed yet (SPEC M3 "Rescan/reconcile"; Task 5
    # brief). `patch_model` allows clearing it so the UI can dismiss the flag.
    review_state: Mapped[str | None] = mapped_column(String)
    is_archived: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=false())
    created_at: Mapped[datetime] = mapped_column(server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        server_default=func.now(), onupdate=func.now(), nullable=False
    )

    # Ambiguous without foreign_keys=: models<->revisions has two FK paths
    # (revisions.model_id -> models.id, and models.current_revision_id ->
    # revisions.id above).
    revisions: Mapped[list["Revision"]] = relationship(foreign_keys="Revision.model_id")
    tags: Mapped[list["Tag"]] = relationship(secondary=model_tags)
    notes: Mapped[list["Note"]] = relationship()


class Tag(Base):
    """A user-defined tag (SPEC ``tags``)."""

    __tablename__ = "tags"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    name: Mapped[str] = mapped_column(String, unique=True, nullable=False)


class Note(Base):
    """A markdown note on a model or a specific revision (SPEC ``notes``)."""

    __tablename__ = "notes"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    model_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("models.id", ondelete="CASCADE"), nullable=False
    )
    # NULL = model-level note.
    revision_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("revisions.id", ondelete="CASCADE")
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        server_default=func.now(), onupdate=func.now(), nullable=False
    )


class Revision(Base):
    """A full-snapshot revision of a model (SPEC ``revisions``)."""

    __tablename__ = "revisions"
    __table_args__ = (UniqueConstraint("model_id", "number"),)

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    model_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("models.id", ondelete="CASCADE"), nullable=False
    )
    number: Mapped[int] = mapped_column(Integer, nullable=False)
    name: Mapped[str | None] = mapped_column(String)
    note: Mapped[str | None] = mapped_column(Text)
    dir_name: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now(), nullable=False)

    files: Mapped[list["File"]] = relationship()


class Blob(Base):
    """Content-addressed blob: the unit of dedup and metadata attachment
    (SPEC ``blobs``).
    """

    __tablename__ = "blobs"
    __table_args__ = (
        # Backs the gallery's `format=` filter (Task 7 brief D1).
        Index("ix_blobs_format", "format"),
    )

    hash: Mapped[str] = mapped_column(CHAR(64), primary_key=True)
    size: Mapped[int] = mapped_column(BigInteger, nullable=False)
    kind: Mapped[BlobKind] = mapped_column(str_enum(BlobKind, "blob_kind"), nullable=False)
    format: Mapped[BlobFormat] = mapped_column(str_enum(BlobFormat, "blob_format"), nullable=False)
    first_seen_at: Mapped[datetime] = mapped_column(server_default=func.now(), nullable=False)

    # No column changes -- these are relationships only (Task 7 brief), read
    # via `selectinload` by the detail/file-enrichment queries in
    # `app.services.library` to compute `FileOut`'s meta/thumb_ready/
    # glb_status/glb_preview_ready fields without a query per file.
    meta: Mapped["BlobMeta | None"] = relationship()
    derivatives: Mapped[list["Derivative"]] = relationship()


class File(Base):
    """A path within a revision snapshot, pointing at a blob (SPEC ``files``)."""

    __tablename__ = "files"
    __table_args__ = (UniqueConstraint("revision_id", "rel_path"),)

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    revision_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("revisions.id", ondelete="CASCADE"), nullable=False, index=True
    )
    blob_hash: Mapped[str] = mapped_column(
        CHAR(64), ForeignKey("blobs.hash"), nullable=False, index=True
    )
    rel_path: Mapped[str] = mapped_column(Text, nullable=False)
    # Denormalized full storage-backend path, for rescan without re-deriving
    # layout from rel_path.
    storage_path: Mapped[str] = mapped_column(Text, nullable=False, index=True)
    mtime: Mapped[datetime | None]
    verified_at: Mapped[datetime | None]

    blob: Mapped["Blob"] = relationship()
