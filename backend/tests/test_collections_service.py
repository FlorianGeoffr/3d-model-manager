"""Followed-collection CRUD + review queue (M8 H, ``app.services.collections``)."""

from __future__ import annotations

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app.models.collections import FollowedCollection, PendingImport, RemoteCollectionItem
from app.models.enums import (
    BlobFormat,
    BlobKind,
    CollectionSyncMode,
    DerivativeKind,
    DerivativeStatus,
    ImportSite,
)
from app.models.library import Blob, Model, Revision
from app.models.processing import Derivative
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


def test_add_pending_sync_no_ops_when_queued_under_a_different_collection() -> None:
    """R7 T1: item identity for dedup is ``(site, external_id)`` SITE-WIDE,
    not per collection -- a second followed list discovering the same item
    must not queue a duplicate row."""
    from app.tasks import base

    with base.sync_session() as session:
        coll_a = FollowedCollection(
            site=ImportSite.THINGIVERSE,
            list_id="a",
            kind="collection",
            title="A",
            mode=CollectionSyncMode.REVIEW,
        )
        coll_b = FollowedCollection(
            site=ImportSite.THINGIVERSE,
            list_id="b",
            kind="collection",
            title="B",
            mode=CollectionSyncMode.REVIEW,
        )
        session.add_all([coll_a, coll_b])
        session.commit()

        first = svc.add_pending_sync(
            session, coll_a, external_id="9", title="Thing", url="https://x/9"
        )
        second = svc.add_pending_sync(
            session, coll_b, external_id="9", title="Thing", url="https://x/9"
        )
        assert first is True and second is False

        pending_rows = session.execute(select(PendingImport)).scalars().all()
        assert len(pending_rows) == 1
        assert pending_rows[0].collection_id == coll_a.id


def test_drop_pending_sync_removes_regardless_of_which_collection_minted_it() -> None:
    """An item that lands in the library must leave the review queue no
    matter which followed list's sync run originally queued it -- so
    ``drop_pending_sync`` deletes by ``(site, external_id)``, not
    ``(collection_id, external_id)``."""
    from app.tasks import base

    with base.sync_session() as session:
        coll_a = FollowedCollection(
            site=ImportSite.THINGIVERSE,
            list_id="a",
            kind="collection",
            title="A",
            mode=CollectionSyncMode.REVIEW,
        )
        coll_b = FollowedCollection(
            site=ImportSite.THINGIVERSE,
            list_id="b",
            kind="collection",
            title="B",
            mode=CollectionSyncMode.REVIEW,
        )
        session.add_all([coll_a, coll_b])
        session.commit()

        svc.add_pending_sync(session, coll_a, external_id="9", title="Thing", url="https://x/9")

        svc.drop_pending_sync(session, coll_b, "9")  # a DIFFERENT collection, same site

        pending_rows = session.execute(select(PendingImport)).scalars().all()
        assert pending_rows == []


# ---------------------------------------------------------------------------
# R7 T1: `resolve_display_collections` -- group review-queue items by the
# most specific followed list `remote_collection_items` says they're really
# in, instead of the stamped `collection_id` (whichever list's sync happened
# to discover the item first).
# ---------------------------------------------------------------------------


async def _followed_row(
    db_session,
    *,
    site: ImportSite = ImportSite.MAKERWORLD,
    list_id: str,
    title: str,
    mode: CollectionSyncMode = CollectionSyncMode.REVIEW,
) -> FollowedCollection:
    row = FollowedCollection(site=site, list_id=list_id, kind="collection", title=title, mode=mode)
    db_session.add(row)
    await db_session.commit()
    await db_session.refresh(row)
    return row


async def _item_row(
    db_session,
    *,
    site: ImportSite = ImportSite.MAKERWORLD,
    list_id: str,
    external_id: str,
    position: int = 0,
) -> None:
    db_session.add(
        RemoteCollectionItem(
            site=site,
            list_id=list_id,
            external_id=external_id,
            title=f"Item {external_id}",
            url=f"https://x/{external_id}",
            position=position,
        )
    )
    await db_session.commit()


async def _pending_row(
    db_session, *, collection_id: int, site: ImportSite = ImportSite.MAKERWORLD, external_id: str
) -> PendingImport:
    row = PendingImport(
        collection_id=collection_id,
        site=site,
        external_id=external_id,
        title=f"Item {external_id}",
        url=f"https://x/{external_id}",
    )
    db_session.add(row)
    await db_session.commit()
    await db_session.refresh(row)
    return row


@pytest.mark.asyncio
async def test_resolve_display_collections_specific_list_wins_over_aggregate(db_session) -> None:
    aggregate = await _followed_row(db_session, list_id="agg", title="Aggregate")
    specific = await _followed_row(db_session, list_id="spec", title="Specific")
    await _item_row(db_session, list_id=specific.list_id, external_id="1")  # 1 member
    await _item_row(db_session, list_id=aggregate.list_id, external_id="1", position=0)
    await _item_row(db_session, list_id=aggregate.list_id, external_id="2", position=1)
    await _item_row(db_session, list_id=aggregate.list_id, external_id="3", position=2)  # 3 members

    pending = await _pending_row(db_session, collection_id=aggregate.id, external_id="1")

    result = await svc.resolve_display_collections(db_session, [pending])
    assert result[pending.id] == (specific.id, "Specific")


@pytest.mark.asyncio
async def test_resolve_display_collections_two_specific_lists_fewer_members_wins(
    db_session,
) -> None:
    small = await _followed_row(db_session, list_id="small", title="Zzz Small")
    big = await _followed_row(db_session, list_id="big", title="Aaa Big")
    await _item_row(db_session, list_id=small.list_id, external_id="1")  # 1 member
    await _item_row(db_session, list_id=big.list_id, external_id="1", position=0)
    await _item_row(db_session, list_id=big.list_id, external_id="2", position=1)  # 2 members

    pending = await _pending_row(db_session, collection_id=small.id, external_id="1")

    result = await svc.resolve_display_collections(db_session, [pending])
    # `small` has fewer members even though its title sorts after `big`'s --
    # membership count wins over title, title only breaks a TIE.
    assert result[pending.id] == (small.id, "Zzz Small")


@pytest.mark.asyncio
async def test_resolve_display_collections_tie_breaks_by_title_then_id(db_session) -> None:
    b_list = await _followed_row(db_session, list_id="b", title="B List")
    a_list = await _followed_row(db_session, list_id="a", title="A List")
    assert a_list.id > b_list.id  # inserted second -- id tie-break isn't what wins here
    await _item_row(db_session, list_id=b_list.list_id, external_id="1")  # 1 member each: a tie
    await _item_row(db_session, list_id=a_list.list_id, external_id="1")

    pending = await _pending_row(db_session, collection_id=b_list.id, external_id="1")

    result = await svc.resolve_display_collections(db_session, [pending])
    assert result[pending.id] == (a_list.id, "A List")


@pytest.mark.asyncio
async def test_resolve_display_collections_tie_breaks_by_id_when_titles_match(db_session) -> None:
    first = await _followed_row(db_session, list_id="first", title="Same Title")
    second = await _followed_row(db_session, list_id="second", title="Same Title")
    assert first.id < second.id
    await _item_row(db_session, list_id=first.list_id, external_id="1")
    await _item_row(db_session, list_id=second.list_id, external_id="1")

    pending = await _pending_row(db_session, collection_id=second.id, external_id="1")

    result = await svc.resolve_display_collections(db_session, [pending])
    assert result[pending.id] == (first.id, "Same Title")


@pytest.mark.asyncio
async def test_resolve_display_collections_falls_back_to_stamped_when_no_membership(
    db_session,
) -> None:
    stamped = await _followed_row(db_session, list_id="stamped", title="Stamped")
    pending = await _pending_row(db_session, collection_id=stamped.id, external_id="404")

    result = await svc.resolve_display_collections(db_session, [pending])
    assert result[pending.id] == (stamped.id, "Stamped")


@pytest.mark.asyncio
async def test_resolve_display_collections_batch_covers_every_pending(db_session) -> None:
    aggregate = await _followed_row(db_session, list_id="agg2", title="Aggregate2")
    specific = await _followed_row(db_session, list_id="spec2", title="Specific2")
    await _item_row(db_session, list_id=specific.list_id, external_id="1")
    await _item_row(db_session, list_id=aggregate.list_id, external_id="1", position=0)
    await _item_row(db_session, list_id=aggregate.list_id, external_id="2", position=1)

    with_membership = await _pending_row(db_session, collection_id=aggregate.id, external_id="1")
    without_membership = await _pending_row(
        db_session, collection_id=aggregate.id, external_id="999"
    )

    result = await svc.resolve_display_collections(
        db_session, [with_membership, without_membership]
    )

    assert set(result) == {with_membership.id, without_membership.id}
    assert result[with_membership.id] == (specific.id, "Specific2")
    assert result[without_membership.id] == (aggregate.id, "Aggregate2")


async def _model_with_ready_cover(
    db_session, *, source_collection_id: int, blob_hash: str
) -> Model:
    blob = Blob(hash=blob_hash, size=10, kind=BlobKind.MESH, format=BlobFormat.STL)
    db_session.add(blob)
    await db_session.flush()
    db_session.add(
        Derivative(blob_hash=blob_hash, kind=DerivativeKind.THUMB_256, status=DerivativeStatus.OK)
    )
    model = Model(
        slug=f"model-{blob_hash[:8]}",
        name=f"Model {blob_hash[:8]}",
        tags=[],
        source_collection_id=source_collection_id,
        cover_blob_hash=blob_hash,
    )
    db_session.add(model)
    await db_session.flush()
    revision = Revision(model_id=model.id, number=1, name="imported", dir_name="r1")
    db_session.add(revision)
    await db_session.flush()
    model.current_revision_id = revision.id
    await db_session.flush()
    return model


@pytest.mark.asyncio
async def test_preview_thumbnails_by_collection_returns_ready_covers(db_session) -> None:
    followed = await _follow(db_session, list_id="preview1")
    await _model_with_ready_cover(db_session, source_collection_id=followed.id, blob_hash="a" * 64)
    await _model_with_ready_cover(db_session, source_collection_id=followed.id, blob_hash="b" * 64)
    await db_session.commit()

    previews = await svc.preview_thumbnails_by_collection(db_session, [followed.id])

    assert len(previews[followed.id]) == 2
    assert all(url.startswith("/api/blobs/") for url in previews[followed.id])


@pytest.mark.asyncio
async def test_preview_thumbnails_by_collection_caps_at_four(db_session) -> None:
    followed = await _follow(db_session, list_id="preview2")
    for i in range(6):
        await _model_with_ready_cover(
            db_session, source_collection_id=followed.id, blob_hash=f"{i}" * 64
        )
    await db_session.commit()

    previews = await svc.preview_thumbnails_by_collection(db_session, [followed.id])

    assert len(previews[followed.id]) <= 4


@pytest.mark.asyncio
async def test_preview_thumbnails_by_collection_empty_for_no_ids(db_session) -> None:
    assert await svc.preview_thumbnails_by_collection(db_session, []) == {}
