"""Followed-collection CRUD + review queue (M8 H, ``app.services.collections``)."""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from app.models.enums import CollectionSyncMode, ImportSite
from app.services import collections as svc


async def _follow(db_session, list_id: str = "42", mode=CollectionSyncMode.REVIEW):
    return await svc.follow(
        db_session,
        site=ImportSite.MAKERWORLD,
        list_id=list_id,
        kind="collection",
        title=f"List {list_id}",
        mode=mode,
    )


@pytest.mark.asyncio
async def test_follow_then_list_and_get(db_session) -> None:
    row = await _follow(db_session)

    assert row.id is not None and row.mode == CollectionSyncMode.REVIEW
    assert [r.id for r in await svc.list_followed(db_session)] == [row.id]
    assert (await svc.get_followed(db_session, row.id)).title == "List 42"


@pytest.mark.asyncio
async def test_following_the_same_list_twice_is_a_409(db_session) -> None:
    await _follow(db_session)
    with pytest.raises(HTTPException) as exc:
        await _follow(db_session)
    assert exc.value.status_code == 409


@pytest.mark.asyncio
async def test_get_unknown_followed_is_404(db_session) -> None:
    with pytest.raises(HTTPException) as exc:
        await svc.get_followed(db_session, 999_999)
    assert exc.value.status_code == 404


@pytest.mark.asyncio
async def test_set_mode_switches_between_auto_and_review(db_session) -> None:
    row = await _follow(db_session)
    updated = await svc.set_mode(db_session, row.id, CollectionSyncMode.AUTO)
    assert updated.mode == CollectionSyncMode.AUTO


@pytest.mark.asyncio
async def test_unfollow_cascades_its_pending_items(db_session) -> None:
    from app.models.collections import PendingImport

    row = await _follow(db_session)
    db_session.add(
        PendingImport(
            collection_id=row.id,
            site=row.site,
            external_id="7",
            title="Queued",
            url="https://makerworld.com/en/models/7",
        )
    )
    await db_session.commit()
    assert len(await svc.list_pending(db_session)) == 1

    await svc.unfollow(db_session, row.id)

    assert await svc.list_followed(db_session) == []
    assert await svc.list_pending(db_session) == []  # ON DELETE CASCADE


@pytest.mark.asyncio
async def test_delete_pending_and_404_for_unknown(db_session) -> None:
    from app.models.collections import PendingImport

    row = await _follow(db_session)
    pending = PendingImport(
        collection_id=row.id, site=row.site, external_id="7", title="Q", url="https://x/7"
    )
    db_session.add(pending)
    await db_session.commit()
    await db_session.refresh(pending)

    await svc.delete_pending(db_session, pending.id)
    assert await svc.list_pending(db_session) == []

    with pytest.raises(HTTPException) as exc:
        await svc.get_pending(db_session, 999_999)
    assert exc.value.status_code == 404


def test_sync_twins_queue_an_item_once_and_record_a_run() -> None:
    """`add_pending_sync` is a no-op the second time (unique per list+item), so
    a repeated review-mode sync never duplicates its queue."""
    from app.tasks import base

    with base.sync_session() as session:
        from app.models.collections import FollowedCollection

        collection = FollowedCollection(
            site=ImportSite.THINGIVERSE,
            list_id="likes",
            kind="likes",
            title="Likes",
            mode=CollectionSyncMode.REVIEW,
        )
        session.add(collection)
        session.commit()

        assert svc.list_followed_sync(session)[0].id == collection.id

        first = svc.add_pending_sync(
            session, collection, external_id="9", title="Thing", url="https://x/9"
        )
        second = svc.add_pending_sync(
            session, collection, external_id="9", title="Thing", url="https://x/9"
        )
        assert first is True and second is False

        svc.mark_synced_sync(session, collection, error="boom")
        session.refresh(collection)
        assert collection.last_error == "boom" and collection.last_synced_at is not None
