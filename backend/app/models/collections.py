"""Followed remote collections + the review queue (M8 H "import your saved
models and keep them synced").

A ``FollowedCollection`` is a remote list the user follows -- a MakerWorld
collection, a Thingiverse/Printables collection, or a site's "likes" pseudo-list
-- identified by ``(site, list_id)``. Each carries its own ``mode``: an
``auto`` list imports newly discovered items straight away, a ``review`` list
parks them in ``pending_imports`` for one-click approval instead.

The sync task never needs a per-list cursor: item identity is
``(site, external_id)`` and ``app.services.import_dedup`` already answers "is
this in the library?", so re-walking a list is naturally idempotent. That keeps
the schema free of site-specific pagination state.
"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import BigInteger, ForeignKey, Identity, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, str_enum
from app.models.enums import CollectionSyncMode, ImportSite


class FollowedCollection(Base):
    """A remote list the user follows and wants kept in sync."""

    __tablename__ = "followed_collections"
    __table_args__ = (
        UniqueConstraint("site", "list_id", name="uq_followed_collections_site_list"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    site: Mapped[ImportSite] = mapped_column(str_enum(ImportSite, "import_site"), nullable=False)
    # The remote list's own identifier (a collection id, or a sentinel like
    # "likes" for a site's favourites pseudo-list).
    list_id: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)  # "collection" | "likes"
    title: Mapped[str] = mapped_column(Text, nullable=False)
    mode: Mapped[CollectionSyncMode] = mapped_column(
        str_enum(CollectionSyncMode, "collection_sync_mode"), nullable=False
    )
    last_synced_at: Mapped[datetime | None]
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now(), nullable=False)


class PendingImport(Base):
    """An item a ``review``-mode sync discovered but did NOT import. Approving
    one just POSTs its ``url`` through the normal import path (which is itself
    dedup-guarded), then deletes this row."""

    __tablename__ = "pending_imports"
    __table_args__ = (
        UniqueConstraint("collection_id", "external_id", name="uq_pending_imports_collection_item"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    collection_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("followed_collections.id", ondelete="CASCADE"), nullable=False
    )
    site: Mapped[ImportSite] = mapped_column(str_enum(ImportSite, "import_site"), nullable=False)
    external_id: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, nullable=False)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    thumbnail_url: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now(), nullable=False)
