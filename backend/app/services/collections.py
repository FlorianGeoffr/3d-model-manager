"""Followed-collection CRUD + review-queue service (M8 H).

Async functions back the API; the ``_sync`` twins back the Celery sync task
(``app.tasks.sync_collections``), mirroring the split in
``app.services.storage_backends``.
"""

from __future__ import annotations

from datetime import UTC, datetime

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session as SyncSession

from app.models.collections import FollowedCollection, PendingImport
from app.models.enums import CollectionSyncMode, ImportSite

# -- followed collections -------------------------------------------------


async def list_followed(db: AsyncSession) -> list[FollowedCollection]:
    stmt = select(FollowedCollection).order_by(FollowedCollection.id)
    return list((await db.execute(stmt)).scalars().all())


async def get_followed(db: AsyncSession, collection_id: int) -> FollowedCollection:
    row = await db.get(FollowedCollection, collection_id)
    if row is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, f"followed collection {collection_id} not found"
        )
    return row


async def follow(
    db: AsyncSession,
    *,
    site: ImportSite,
    list_id: str,
    kind: str,
    title: str,
    mode: CollectionSyncMode = CollectionSyncMode.REVIEW,
) -> FollowedCollection:
    """Follow a remote list. Following the same ``(site, list_id)`` twice is a
    409 rather than a silent duplicate -- the UI should offer "unfollow"."""
    existing = (
        await db.execute(
            select(FollowedCollection).where(
                FollowedCollection.site == site, FollowedCollection.list_id == list_id
            )
        )
    ).scalars().first()
    if existing is not None:
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"already following {site.value} list {list_id!r}"
        )
    row = FollowedCollection(site=site, list_id=list_id, kind=kind, title=title, mode=mode)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return row


async def unfollow(db: AsyncSession, collection_id: int) -> None:
    """Unfollow. Its queued `pending_imports` go with it (FK ON DELETE CASCADE)
    -- they only ever meant "this followed list found something new"."""
    row = await get_followed(db, collection_id)
    await db.delete(row)
    await db.commit()


async def set_mode(
    db: AsyncSession, collection_id: int, mode: CollectionSyncMode
) -> FollowedCollection:
    row = await get_followed(db, collection_id)
    row.mode = mode
    await db.commit()
    await db.refresh(row)
    return row


# -- review queue ---------------------------------------------------------


async def list_pending(db: AsyncSession, collection_id: int | None = None) -> list[PendingImport]:
    stmt = select(PendingImport).order_by(PendingImport.id)
    if collection_id is not None:
        stmt = stmt.where(PendingImport.collection_id == collection_id)
    return list((await db.execute(stmt)).scalars().all())


async def get_pending(db: AsyncSession, pending_id: int) -> PendingImport:
    row = await db.get(PendingImport, pending_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"pending import {pending_id} not found")
    return row


async def delete_pending(db: AsyncSession, pending_id: int) -> None:
    row = await get_pending(db, pending_id)
    await db.delete(row)
    await db.commit()


# -- worker-side twins ----------------------------------------------------


def list_followed_sync(session: SyncSession) -> list[FollowedCollection]:
    stmt = select(FollowedCollection).order_by(FollowedCollection.id)
    return list(session.execute(stmt).scalars())


def mark_synced_sync(
    session: SyncSession, collection: FollowedCollection, *, error: str | None = None
) -> None:
    collection.last_synced_at = datetime.now(UTC)
    collection.last_error = error
    session.commit()


def add_pending_sync(
    session: SyncSession,
    collection: FollowedCollection,
    *,
    external_id: str,
    title: str,
    url: str,
    thumbnail_url: str | None = None,
) -> bool:
    """Queue an item for review. Returns True when it was newly queued, False
    when this list had already queued it (the unique
    ``(collection_id, external_id)`` pair) -- so a repeated sync is a no-op."""
    already = session.execute(
        select(PendingImport.id).where(
            PendingImport.collection_id == collection.id,
            PendingImport.external_id == external_id,
        )
    ).first()
    if already is not None:
        return False
    session.add(
        PendingImport(
            collection_id=collection.id,
            site=collection.site,
            external_id=external_id,
            title=title,
            url=url,
            thumbnail_url=thumbnail_url,
        )
    )
    session.commit()
    return True
