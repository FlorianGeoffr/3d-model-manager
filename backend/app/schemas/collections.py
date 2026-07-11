"""Schemas for followed remote collections + the review queue (M8 H)."""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Annotated

from pydantic import BaseModel, StringConstraints

from app.models.enums import CollectionSyncMode, ImportSite

if TYPE_CHECKING:
    from app.models.collections import FollowedCollection, PendingImport

NonEmptyStr = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class FollowedCollectionOut(BaseModel):
    id: int
    site: str
    list_id: str
    kind: str
    title: str
    mode: str
    last_synced_at: datetime | None
    last_error: str | None
    created_at: datetime

    @classmethod
    def from_model(cls, row: FollowedCollection) -> FollowedCollectionOut:
        return cls(
            id=row.id,
            site=row.site,
            list_id=row.list_id,
            kind=row.kind,
            title=row.title,
            mode=row.mode,
            last_synced_at=row.last_synced_at,
            last_error=row.last_error,
            created_at=row.created_at,
        )


class FollowCollectionIn(BaseModel):
    site: ImportSite
    list_id: NonEmptyStr
    kind: str = "collection"
    title: NonEmptyStr
    mode: CollectionSyncMode = CollectionSyncMode.REVIEW


class CollectionModeIn(BaseModel):
    mode: CollectionSyncMode


class FollowFromUrlIn(BaseModel):
    """``POST /collections/from-url`` (M10 escape hatch B): follow a
    MakerWorld collection by pasting its URL instead of picking it off a
    list -- the SSR route that would otherwise enumerate it is intermittently
    Cloudflare-walled (``app.importers.makerworld``'s module docstring)."""

    url: NonEmptyStr
    mode: CollectionSyncMode = CollectionSyncMode.REVIEW


class PendingImportOut(BaseModel):
    id: int
    collection_id: int
    site: str
    external_id: str
    title: str
    url: str
    thumbnail_url: str | None
    created_at: datetime

    @classmethod
    def from_model(cls, row: PendingImport) -> PendingImportOut:
        return cls(
            id=row.id,
            collection_id=row.collection_id,
            site=row.site,
            external_id=row.external_id,
            title=row.title,
            url=row.url,
            thumbnail_url=row.thumbnail_url,
            created_at=row.created_at,
        )
