"""``app.services.remote_collections`` (M10 escape hatch A): the
``remote_collection_cache`` upsert/replace/lookup service shared by the
extension push (``POST /ext/collections``), the MakerWorld importer's
self-heal (``list_user_lists``), and the add-by-URL title lookup
(``POST /collections/from-url``). The API/importer integration tests
(``test_ext_api.py``, ``test_makerworld_importer.py``, ``test_collections_api
.py``) already exercise this through those callers; this module covers the
service directly, including behaviour (ordering, a same-process sync/async
round trip) none of those callers happen to assert on their own.
"""

from __future__ import annotations

import pytest

from app.models.enums import ImportSite
from app.services import remote_collections as svc
from app.tasks import base as tasks_base


@pytest.mark.asyncio
async def test_replace_site_cache_upserts_then_deletes_what_was_dropped(db_session) -> None:
    await svc.replace_site_cache(
        db_session,
        ImportSite.MAKERWORLD,
        [
            svc.CacheEntry(list_id="1", title="One"),
            svc.CacheEntry(list_id="2", title="Two"),
        ],
    )
    entry = await svc.get_cache_entry(db_session, ImportSite.MAKERWORLD, "1")
    assert entry is not None and entry.title == "One"

    count = await svc.replace_site_cache(
        db_session, ImportSite.MAKERWORLD, [svc.CacheEntry(list_id="1", title="One (renamed)")]
    )
    assert count == 1
    assert (await svc.get_cache_entry(db_session, ImportSite.MAKERWORLD, "1")).title == (
        "One (renamed)"
    )
    assert await svc.get_cache_entry(db_session, ImportSite.MAKERWORLD, "2") is None


@pytest.mark.asyncio
async def test_replace_site_cache_is_scoped_per_site(db_session) -> None:
    """Replacing THINGIVERSE's cache must not touch a MAKERWORLD row with the
    same `list_id` -- the unique key (and every query here) is `(site,
    list_id)`, not `list_id` alone."""
    await svc.replace_site_cache(
        db_session, ImportSite.MAKERWORLD, [svc.CacheEntry(list_id="1", title="MW One")]
    )
    await svc.replace_site_cache(
        db_session, ImportSite.THINGIVERSE, [svc.CacheEntry(list_id="1", title="TV One")]
    )
    assert (await svc.get_cache_entry(db_session, ImportSite.MAKERWORLD, "1")).title == "MW One"
    assert (await svc.get_cache_entry(db_session, ImportSite.THINGIVERSE, "1")).title == "TV One"


@pytest.mark.asyncio
async def test_replace_site_cache_with_empty_list_clears_the_site(db_session) -> None:
    await svc.replace_site_cache(
        db_session, ImportSite.MAKERWORLD, [svc.CacheEntry(list_id="1", title="One")]
    )
    count = await svc.replace_site_cache(db_session, ImportSite.MAKERWORLD, [])
    assert count == 0
    assert await svc.get_cache_entry(db_session, ImportSite.MAKERWORLD, "1") is None


@pytest.mark.asyncio
async def test_get_site_cache_orders_default_first_then_title(db_session) -> None:
    """`get_site_cache` (the sync twin the importer's merge step reads) sorts
    `is_default` first, then title -- so a user's default collection always
    surfaces first among the named ones. `db_session` is requested only for
    its truncation side effect (see conftest.py) -- the reads/writes below go
    through the SYNC session, same as the importer's worker-side callers."""
    with tasks_base.sync_session() as session:
        svc.replace_site_cache_sync(
            session,
            ImportSite.MAKERWORLD,
            [
                svc.CacheEntry(list_id="3", title="Zebra"),
                svc.CacheEntry(list_id="1", title="Default", is_default=True),
                svc.CacheEntry(list_id="2", title="Apple"),
            ],
        )
        ordered = [row.list_id for row in svc.get_site_cache(session, ImportSite.MAKERWORLD)]
    assert ordered == ["1", "2", "3"]


@pytest.mark.asyncio
async def test_replace_site_cache_sync_round_trips_with_the_async_writer(db_session) -> None:
    """The importer (sync/worker world) and the ext endpoint (async/API
    world) write through the same table -- a sync write must be visible to a
    later sync read regardless of which side wrote it first."""
    with tasks_base.sync_session() as session:
        svc.replace_site_cache_sync(
            session, ImportSite.MAKERWORLD, [svc.CacheEntry(list_id="9", title="Nine", count=3)]
        )
        rows = svc.get_site_cache(session, ImportSite.MAKERWORLD)
    assert [r.title for r in rows] == ["Nine"]
    assert rows[0].count == 3
