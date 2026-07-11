"""Followed collections API + the periodic sync task (M8 H).

The sync is driven with a stub importer whose ``list_list_items`` returns real
``SearchResult``s, since no site's authenticated collection endpoints are wired
yet (they need a live logged-in capture).
"""

from __future__ import annotations

import pytest

from tests import corpus


def _stub_importer(monkeypatch, items):
    """Register a stub for THINGIVERSE exposing one list containing `items`,
    while keeping the `fake_import` importer's download/metadata behaviour for
    the URLs those items point at."""
    from app.importers.base import RemoteList, SearchResult
    from app.importers.registry import IMPORTER_REGISTRY
    from app.models.enums import ImportSite

    real = IMPORTER_REGISTRY[ImportSite.THINGIVERSE]

    class Stub:
        site = ImportSite.THINGIVERSE

        # delegate the import pipeline bits to the fake importer
        def canonicalize(self, url):
            return real.canonicalize(url)

        def fetch_metadata(self, external_id):
            return real.fetch_metadata(external_id)

        def list_files(self, external_id):
            return real.list_files(external_id)

        def resolve_download(self, external_id, file):
            return real.resolve_download(external_id, file)

        def search(self, query, page=1):
            return []

        def list_user_lists(self):
            return [
                RemoteList(
                    site=ImportSite.THINGIVERSE, list_id="likes", kind="likes", title="Likes"
                )
            ]

        def list_list_items(self, list_id, page=1):
            if page > 1:
                return []
            return [
                SearchResult(
                    site=ImportSite.THINGIVERSE,
                    external_id=str(i),
                    title=f"Thing {i}",
                    url=f"https://fake.test/thing/{i}",
                )
                for i in items
            ]

    monkeypatch.setitem(IMPORTER_REGISTRY, ImportSite.THINGIVERSE, Stub())


async def _follow(client, mode: str):
    r = await client.post(
        "/api/collections",
        json={
            "site": "thingiverse",
            "list_id": "likes",
            "kind": "likes",
            "title": "Likes",
            "mode": mode,
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


def test_periodic_sync_is_opt_in_so_no_beat_entry_by_default() -> None:
    """The beat schedule is built additively and each entry is gated on its own
    positive interval setting -- with the defaults (0) neither is registered,
    and "Sync now" still works."""
    from app.tasks.celery_app import celery_app

    assert "sync-collections" not in (celery_app.conf.beat_schedule or {})


@pytest.mark.asyncio
async def test_follow_list_patch_mode_and_unfollow(authenticated_client, library_root, data_dir):
    body = await _follow(authenticated_client, "review")
    assert body["mode"] == "review" and body["last_synced_at"] is None

    listing = await authenticated_client.get("/api/collections")
    assert [c["id"] for c in listing.json()] == [body["id"]]

    patched = await authenticated_client.patch(
        f"/api/collections/{body['id']}", json={"mode": "auto"}
    )
    assert patched.status_code == 200 and patched.json()["mode"] == "auto"

    # following the same list twice is a 409, not a silent duplicate
    dup = await authenticated_client.post(
        "/api/collections",
        json={"site": "thingiverse", "list_id": "likes", "kind": "likes", "title": "Likes"},
    )
    assert dup.status_code == 409

    gone = await authenticated_client.delete(f"/api/collections/{body['id']}")
    assert gone.status_code == 204
    assert (await authenticated_client.get("/api/collections")).json() == []


@pytest.mark.asyncio
async def test_auto_mode_sync_imports_new_items_and_never_duplicates(
    authenticated_client, library_root, data_dir, fake_import, monkeypatch
):
    fake_import.files = {"cube.stl": corpus.box_stl()}
    _stub_importer(monkeypatch, items=[42])
    await _follow(authenticated_client, "auto")

    first = await authenticated_client.post("/api/collections/sync")
    assert first.status_code == 200, first.text
    assert first.json()["state"] == "done"  # eager celery ran it inline

    gallery = await authenticated_client.get("/api/models")
    assert len(gallery.json()["items"]) == 1

    # a SECOND sync must be a no-op -- this is the whole point of the dedup guard
    second = await authenticated_client.post("/api/collections/sync")
    assert second.status_code == 200 and second.json()["state"] == "done"
    gallery = await authenticated_client.get("/api/models")
    assert len(gallery.json()["items"]) == 1

    # nothing was queued for review in auto mode
    assert (await authenticated_client.get("/api/collections/pending")).json() == []


@pytest.mark.asyncio
async def test_review_mode_sync_queues_items_without_importing_then_approve(
    authenticated_client, library_root, data_dir, fake_import, monkeypatch
):
    fake_import.files = {"cube.stl": corpus.box_stl()}
    _stub_importer(monkeypatch, items=[42])
    await _follow(authenticated_client, "review")

    sync = await authenticated_client.post("/api/collections/sync")
    assert sync.status_code == 200 and sync.json()["state"] == "done"

    # queued, NOT imported
    pending = (await authenticated_client.get("/api/collections/pending")).json()
    assert [p["external_id"] for p in pending] == ["42"]
    assert (await authenticated_client.get("/api/models")).json()["items"] == []

    # a repeat sync must not double-queue it
    await authenticated_client.post("/api/collections/sync")
    assert len((await authenticated_client.get("/api/collections/pending")).json()) == 1

    approved = await authenticated_client.post(
        f"/api/collections/pending/{pending[0]['id']}/approve"
    )
    assert approved.status_code == 201, approved.text
    assert approved.json()["state"] == "done" and approved.json()["model_id"] is not None

    assert (await authenticated_client.get("/api/collections/pending")).json() == []
    assert len((await authenticated_client.get("/api/models")).json()["items"]) == 1


@pytest.mark.asyncio
async def test_review_queue_drops_an_item_once_it_lands_in_the_library(
    authenticated_client, library_root, data_dir, fake_import, monkeypatch
):
    """An item imported some other way must not keep reappearing in the queue."""
    fake_import.files = {"cube.stl": corpus.box_stl()}
    _stub_importer(monkeypatch, items=[42])
    await _follow(authenticated_client, "review")

    await authenticated_client.post("/api/collections/sync")
    assert len((await authenticated_client.get("/api/collections/pending")).json()) == 1

    # import it directly (as if from search), then re-sync
    direct = await authenticated_client.post(
        "/api/imports", json={"url": "https://fake.test/thing/42"}
    )
    assert direct.status_code == 201 and direct.json()["state"] == "done"

    await authenticated_client.post("/api/collections/sync")
    assert (await authenticated_client.get("/api/collections/pending")).json() == []


@pytest.mark.asyncio
async def test_dismiss_pending_import(
    authenticated_client, library_root, data_dir, fake_import, monkeypatch
):
    _stub_importer(monkeypatch, items=[42])
    await _follow(authenticated_client, "review")
    await authenticated_client.post("/api/collections/sync")
    pending = (await authenticated_client.get("/api/collections/pending")).json()

    r = await authenticated_client.delete(f"/api/collections/pending/{pending[0]['id']}")
    assert r.status_code == 204
    assert (await authenticated_client.get("/api/collections/pending")).json() == []


# ---------------------------------------------------------------------------
# Branch 3 Task 1: models carry the followed collection they were imported
# from (id + a denormalized title snapshot) all the way through to the
# gallery/detail API surface.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_auto_mode_sync_stamps_source_collection_on_imported_model(
    authenticated_client, library_root, data_dir, fake_import, monkeypatch
):
    fake_import.files = {"cube.stl": corpus.box_stl()}
    _stub_importer(monkeypatch, items=[42])
    followed = await _follow(authenticated_client, "auto")

    sync = await authenticated_client.post("/api/collections/sync")
    assert sync.status_code == 200 and sync.json()["state"] == "done"

    gallery = await authenticated_client.get("/api/models")
    items = gallery.json()["items"]
    assert len(items) == 1
    assert items[0]["source_collection_id"] == followed["id"]
    assert items[0]["source_collection_title"] == "Likes"

    detail = await authenticated_client.get(f"/api/models/{items[0]['slug']}")
    assert detail.json()["source_collection_id"] == followed["id"]
    assert detail.json()["source_collection_title"] == "Likes"


@pytest.mark.asyncio
async def test_review_mode_approve_stamps_source_collection_on_imported_model(
    authenticated_client, library_root, data_dir, fake_import, monkeypatch
):
    fake_import.files = {"cube.stl": corpus.box_stl()}
    _stub_importer(monkeypatch, items=[42])
    followed = await _follow(authenticated_client, "review")

    await authenticated_client.post("/api/collections/sync")
    pending = (await authenticated_client.get("/api/collections/pending")).json()

    approved = await authenticated_client.post(
        f"/api/collections/pending/{pending[0]['id']}/approve"
    )
    assert approved.status_code == 201, approved.text

    gallery = await authenticated_client.get("/api/models")
    items = gallery.json()["items"]
    assert len(items) == 1
    assert items[0]["source_collection_id"] == followed["id"]
    assert items[0]["source_collection_title"] == "Likes"


@pytest.mark.asyncio
async def test_manual_import_leaves_source_collection_null(
    authenticated_client, library_root, data_dir, fake_import
):
    """`POST /imports` (no followed-collection context) must not invent one."""
    fake_import.files = {"cube.stl": corpus.box_stl()}

    direct = await authenticated_client.post(
        "/api/imports", json={"url": "https://fake.test/thing/42"}
    )
    assert direct.status_code == 201 and direct.json()["state"] == "done"

    gallery = await authenticated_client.get("/api/models")
    item = gallery.json()["items"][0]
    assert item["source_collection_id"] is None
    assert item["source_collection_title"] is None


@pytest.mark.asyncio
async def test_sync_backfills_provenance_onto_a_pre_existing_import_but_never_overwrites(
    authenticated_client, library_root, data_dir, fake_import, monkeypatch
):
    """A model imported before this feature existed (or pasted manually) has
    NULL ``source_collection_id`` -- the first sync that lists it (from
    ANY followed list, auto or review) heals it in place via the
    already-imported/"skip" path. A second, DIFFERENT followed list that also
    lists the same item must not steal provenance from the first."""
    fake_import.files = {"cube.stl": corpus.box_stl()}

    direct = await authenticated_client.post(
        "/api/imports", json={"url": "https://fake.test/thing/42"}
    )
    assert direct.status_code == 201

    _stub_importer(monkeypatch, items=[42])
    first_collection = await _follow(authenticated_client, "auto")

    sync1 = await authenticated_client.post("/api/collections/sync")
    assert sync1.status_code == 200

    gallery = await authenticated_client.get("/api/models")
    item = gallery.json()["items"][0]
    assert item["source_collection_id"] == first_collection["id"]
    assert item["source_collection_title"] == "Likes"

    second = await authenticated_client.post(
        "/api/collections",
        json={
            "site": "thingiverse",
            "list_id": "other",
            "kind": "collection",
            "title": "Other Collection",
            "mode": "review",
        },
    )
    assert second.status_code == 201

    sync2 = await authenticated_client.post("/api/collections/sync")
    assert sync2.status_code == 200

    gallery2 = await authenticated_client.get("/api/models")
    item2 = gallery2.json()["items"][0]
    assert item2["source_collection_id"] == first_collection["id"]
    assert item2["source_collection_title"] == "Likes"
    # The second list must not have queued it for review either -- it's
    # already in the library.
    assert (await authenticated_client.get("/api/collections/pending")).json() == []


@pytest.mark.asyncio
async def test_unfollowing_a_collection_nulls_source_collection_id_but_keeps_title(
    authenticated_client, library_root, data_dir, fake_import, monkeypatch, db_session
):
    """ON DELETE SET NULL nulls the FK, but the denormalized title snapshot
    survives -- provenance stays legible even after the collection is gone."""
    from app.models.library import Model

    fake_import.files = {"cube.stl": corpus.box_stl()}
    _stub_importer(monkeypatch, items=[42])
    followed = await _follow(authenticated_client, "auto")

    await authenticated_client.post("/api/collections/sync")
    gallery = await authenticated_client.get("/api/models")
    model_id = gallery.json()["items"][0]["id"]

    unfollow = await authenticated_client.delete(f"/api/collections/{followed['id']}")
    assert unfollow.status_code == 204

    model = await db_session.get(Model, model_id)
    assert model.source_collection_id is None
    assert model.source_collection_title == "Likes"
