"""``remote_collection_cache`` service (M10 escape hatch A).

Two independent producers keep the cache warm: the browser extension pushes
a full authoritative snapshot of a site's collections (``POST
/ext/collections``, API/async world), and ``MakerWorldImporter.list_user_lists``
(``app.importers.makerworld``) upserts into it whenever the SSR route it
normally reads happens to succeed on its own (worker/sync world, via
``app.tasks.base.sync_session`` -- mirrors the async/sync split in
``app.services.storage_backends``). Both funnel through ``replace_site_cache``
(or its sync twin): the pushed/fetched set is treated as the site's full
current list, so anything cached for that site but NOT in the new set is
stale and gets deleted -- a collection the user deleted/unfollowed on the
remote site should disappear from the cache too, not linger forever.
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import delete as sa_delete
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session as SyncSession

from app.models.collections import RemoteCollectionCache
from app.models.enums import ImportSite


@dataclass(frozen=True)
class CacheEntry:
    """One pushed/fetched collection, decoupled from both the ext API's
    pydantic request schema and the ORM row -- the only shape this service
    needs to know about."""

    list_id: str
    title: str
    slug: str | None = None
    count: int | None = None
    is_default: bool = False


def _upsert_values(site: ImportSite, entry: CacheEntry) -> dict:
    return {
        "site": site,
        "list_id": entry.list_id,
        "title": entry.title,
        "slug": entry.slug,
        "count": entry.count,
        "is_default": entry.is_default,
    }


async def replace_site_cache(db: AsyncSession, site: ImportSite, entries: list[CacheEntry]) -> int:
    """ASYNC twin (API path, ``POST /ext/collections``). Upsert every entry
    by ``(site, list_id)``, then delete whatever else was cached for ``site``
    -- see module docstring for why a partial push is a full replace, not a
    merge. Returns the number of entries just upserted."""
    list_ids = [entry.list_id for entry in entries]
    for entry in entries:
        stmt = pg_insert(RemoteCollectionCache).values(**_upsert_values(site, entry))
        stmt = stmt.on_conflict_do_update(
            index_elements=[RemoteCollectionCache.site, RemoteCollectionCache.list_id],
            set_={
                "title": stmt.excluded.title,
                "slug": stmt.excluded.slug,
                "count": stmt.excluded.count,
                "is_default": stmt.excluded.is_default,
            },
        )
        await db.execute(stmt)
    delete_stmt = sa_delete(RemoteCollectionCache).where(RemoteCollectionCache.site == site)
    if list_ids:
        delete_stmt = delete_stmt.where(RemoteCollectionCache.list_id.notin_(list_ids))
    await db.execute(delete_stmt)
    await db.commit()
    # The upsert/delete above are raw Core statements, so the unit-of-work
    # never syncs any `RemoteCollectionCache` instance already in this
    # session's identity map (e.g. from an earlier `get_cache_entry` call in
    # the same request) -- expire it so the next attribute access re-reads
    # the row this call just wrote, instead of silently returning stale data.
    db.expire_all()
    return len(entries)


def replace_site_cache_sync(
    session: SyncSession, site: ImportSite, entries: list[CacheEntry]
) -> int:
    """SYNC twin (worker path, ``list_user_lists``'s self-heal). Same
    semantics as ``replace_site_cache`` -- see its docstring."""
    list_ids = [entry.list_id for entry in entries]
    for entry in entries:
        stmt = pg_insert(RemoteCollectionCache).values(**_upsert_values(site, entry))
        stmt = stmt.on_conflict_do_update(
            index_elements=[RemoteCollectionCache.site, RemoteCollectionCache.list_id],
            set_={
                "title": stmt.excluded.title,
                "slug": stmt.excluded.slug,
                "count": stmt.excluded.count,
                "is_default": stmt.excluded.is_default,
            },
        )
        session.execute(stmt)
    delete_stmt = sa_delete(RemoteCollectionCache).where(RemoteCollectionCache.site == site)
    if list_ids:
        delete_stmt = delete_stmt.where(RemoteCollectionCache.list_id.notin_(list_ids))
    session.execute(delete_stmt)
    session.commit()
    session.expire_all()  # see `replace_site_cache`'s matching comment
    return len(entries)


def get_site_cache(session: SyncSession, site: ImportSite) -> list[RemoteCollectionCache]:
    """Every cached collection for ``site``, ordered ``is_default`` first
    then title -- the order ``list_user_lists`` merges named collections in."""
    stmt = (
        select(RemoteCollectionCache)
        .where(RemoteCollectionCache.site == site)
        .order_by(RemoteCollectionCache.is_default.desc(), RemoteCollectionCache.title.asc())
    )
    return list(session.execute(stmt).scalars())


async def get_cache_entry(
    db: AsyncSession, site: ImportSite, list_id: str
) -> RemoteCollectionCache | None:
    """ASYNC single-row lookup (API path, ``POST /collections/from-url``'s
    title fill-in) -- None when this (site, list_id) has never been cached."""
    stmt = select(RemoteCollectionCache).where(
        RemoteCollectionCache.site == site, RemoteCollectionCache.list_id == list_id
    )
    return (await db.execute(stmt)).scalars().first()
