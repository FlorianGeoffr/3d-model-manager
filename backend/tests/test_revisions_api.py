"""Revisions: snapshot-copy on creation, diff correctness, and the
current-revision-only mutability rule (Task 5 brief + SPEC "Storage
layer" -> "New revision", "Data model" -> "Revision diff").
"""

import uuid
from collections.abc import Awaitable, Callable
from pathlib import Path

import blake3
import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Blob, File, Model, Revision
from app.models.enums import BlobFormat, BlobKind
from app.services import jobs as jobs_service
from app.storage.local import LocalStorageBackend

pytestmark = pytest.mark.usefixtures("library_root")


async def _create_model(client: httpx.AsyncClient, name: str) -> dict:
    response = await client.post("/api/models", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


async def _load_model_and_current_revision(
    db_session: AsyncSession, model_id: int
) -> tuple[Model, Revision]:
    model = await db_session.get(Model, model_id)
    revision = await db_session.get(Revision, model.current_revision_id)
    return model, revision


async def _seed_pending_file(
    db_session: AsyncSession, model: Model, revision: Revision, rel_path: str, content: bytes
) -> File:
    """Plant a ``File`` row whose store job hasn't settled yet (``verified_at``
    NULL, a live ``queued`` job) WITHOUT writing any bytes through the
    backend -- the DB-visible half of an upload whose ``store_to_backend``
    run is still in flight.
    """
    digest = blake3.blake3(content).hexdigest()
    blob = Blob(hash=digest, size=len(content), kind=BlobKind.MESH, format=BlobFormat.STL)
    db_session.add(blob)
    await db_session.flush()
    file = File(
        revision_id=revision.id,
        blob_hash=digest,
        rel_path=rel_path,
        storage_path=f"{model.slug}/{revision.dir_name}/{rel_path}",
        verified_at=None,
    )
    db_session.add(file)
    await db_session.flush()
    await jobs_service.create_job(
        db_session,
        id=uuid.uuid4(),
        type="store_to_backend",
        subject_type="file",
        subject_id=file.id,
    )
    await db_session.commit()
    await db_session.refresh(file)
    return file


# ---------------------------------------------------------------------------
# creation: full-snapshot copy on disk
# ---------------------------------------------------------------------------


async def test_create_revision_snapshot_copies_all_files_on_disk(
    authenticated_client: httpx.AsyncClient,
    db_session: AsyncSession,
    backend: LocalStorageBackend,
    seed_file: Callable[..., Awaitable[File]],
) -> None:
    created = await _create_model(authenticated_client, "Snapshot Test")
    model, rev1 = await _load_model_and_current_revision(db_session, created["id"])

    await seed_file(model, rev1, "part.stl", b"stl-bytes-one")
    await seed_file(model, rev1, "nested/sub.stl", b"stl-bytes-two")

    response = await authenticated_client.post(f"/api/models/{created['id']}/revisions", json={})

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["number"] == 2
    assert body["dir_name"] == "rev-002_rev"

    files_by_path = {f["rel_path"]: f for f in body["files"]}
    assert set(files_by_path) == {"part.stl", "nested/sub.stl"}
    assert files_by_path["part.stl"]["verified_at"] is None

    # Real bytes exist at the new revision's path -- not just DB rows.
    assert b"".join(backend.read("snapshot-test/rev-002_rev/part.stl")) == b"stl-bytes-one"
    assert b"".join(backend.read("snapshot-test/rev-002_rev/nested/sub.stl")) == b"stl-bytes-two"
    # Original revision's files are untouched.
    assert b"".join(backend.read("snapshot-test/rev-001_initial/part.stl")) == b"stl-bytes-one"


async def test_create_revision_with_unsettled_current_file_is_409_before_touching_disk(
    authenticated_client: httpx.AsyncClient,
    db_session: AsyncSession,
    library_root: Path,
) -> None:
    """``backend.copy()`` on a file whose store job hasn't settled yet would
    raise ``StorageKeyNotFound`` (the source object may not exist on disk
    yet) -- after the new revision directory (and however many files had
    already been copied) were left behind as storage debris. The pre-check
    must reject the whole snapshot up front, before any of that happens.
    """
    created = await _create_model(authenticated_client, "Snapshot Pending Test")
    model, rev1 = await _load_model_and_current_revision(db_session, created["id"])
    await _seed_pending_file(db_session, model, rev1, "pending.stl", b"still-uploading-bytes")

    response = await authenticated_client.post(f"/api/models/{created['id']}/revisions", json={})

    assert response.status_code == 409
    revisions = await authenticated_client.get(f"/api/models/{created['id']}/revisions")
    assert [r["number"] for r in revisions.json()] == [1]
    assert not (library_root / model.slug / "rev-002_rev").exists()


async def test_create_revision_name_slugifies_into_dir_name(
    authenticated_client: httpx.AsyncClient,
) -> None:
    created = await _create_model(authenticated_client, "Named Revision Test")

    response = await authenticated_client.post(
        f"/api/models/{created['id']}/revisions", json={"name": "Fixed Drain Holes"}
    )

    assert response.status_code == 201
    assert response.json()["dir_name"] == "rev-002_fixed-drain-holes"


async def test_create_revision_reuses_blob_hash_without_rehashing(
    authenticated_client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_file: Callable[..., Awaitable[File]],
) -> None:
    created = await _create_model(authenticated_client, "Reuse Hash Test")
    model, rev1 = await _load_model_and_current_revision(db_session, created["id"])
    original = await seed_file(model, rev1, "part.stl", b"content-for-hash-reuse")

    response = await authenticated_client.post(f"/api/models/{created['id']}/revisions", json={})

    new_file = response.json()["files"][0]
    assert new_file["blob_hash"] == original.blob_hash


async def test_list_revisions_returns_both_with_file_counts(
    authenticated_client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_file: Callable[..., Awaitable[File]],
) -> None:
    created = await _create_model(authenticated_client, "List Revisions Test")
    model, rev1 = await _load_model_and_current_revision(db_session, created["id"])
    await seed_file(model, rev1, "a.stl", b"aaa")
    await seed_file(model, rev1, "b.stl", b"bbb")

    await authenticated_client.post(f"/api/models/{created['id']}/revisions", json={})

    response = await authenticated_client.get(f"/api/models/{created['id']}/revisions")

    assert response.status_code == 200
    revisions = response.json()
    assert [r["number"] for r in revisions] == [1, 2]
    assert [r["file_count"] for r in revisions] == [2, 2]


async def test_get_revision_detail(
    authenticated_client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_file: Callable[..., Awaitable[File]],
) -> None:
    created = await _create_model(authenticated_client, "Get Revision Test")
    model, rev1 = await _load_model_and_current_revision(db_session, created["id"])
    await seed_file(model, rev1, "a.stl", b"aaa")

    response = await authenticated_client.get(f"/api/revisions/{rev1.id}")

    assert response.status_code == 200
    body = response.json()
    assert body["number"] == 1
    assert len(body["files"]) == 1
    assert body["files"][0]["rel_path"] == "a.stl"
    assert body["files"][0]["size"] == 3

    # FileOut enrichment (Task 7): no BlobMeta/Derivative rows exist for this
    # seeded file at all, so everything reports its "nothing has run yet"
    # default -- `glb_status` is "pending" (not None) because stl IS a
    # GLB-producing format, just with no derivative row yet.
    file_out = body["files"][0]
    assert file_out["meta"] is None
    assert file_out["thumb_ready"] is False
    assert file_out["glb_status"] == "pending"
    assert file_out["glb_preview_ready"] is False


async def test_get_revision_unknown_id_is_404(authenticated_client: httpx.AsyncClient) -> None:
    response = await authenticated_client.get("/api/revisions/999999")

    assert response.status_code == 404


# ---------------------------------------------------------------------------
# diff
# ---------------------------------------------------------------------------


async def test_diff_all_unchanged_immediately_after_snapshot(
    authenticated_client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_file: Callable[..., Awaitable[File]],
) -> None:
    created = await _create_model(authenticated_client, "Diff Unchanged Test")
    model, rev1 = await _load_model_and_current_revision(db_session, created["id"])
    await seed_file(model, rev1, "a.stl", b"aaa")
    await seed_file(model, rev1, "b.stl", b"bbb")

    create_rev = await authenticated_client.post(f"/api/models/{created['id']}/revisions", json={})
    rev2_id = create_rev.json()["id"]

    response = await authenticated_client.get(f"/api/revisions/{rev1.id}/diff/{rev2_id}")

    assert response.status_code == 200
    body = response.json()
    assert body["added"] == []
    assert body["removed"] == []
    assert body["changed"] == []
    assert {e["rel_path"] for e in body["unchanged"]} == {"a.stl", "b.stl"}
    for entry in body["unchanged"]:
        assert entry["a"]["blob_hash"] == entry["b"]["blob_hash"]


async def test_diff_reports_changed_after_file_replace(
    authenticated_client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_file: Callable[..., Awaitable[File]],
) -> None:
    created = await _create_model(authenticated_client, "Diff Changed Test")
    model, rev1 = await _load_model_and_current_revision(db_session, created["id"])
    await seed_file(model, rev1, "a.stl", b"original-a")
    await seed_file(model, rev1, "b.stl", b"stable-b")

    create_rev = await authenticated_client.post(f"/api/models/{created['id']}/revisions", json={})
    rev2_id = create_rev.json()["id"]
    rev2 = await db_session.get(Revision, rev2_id)

    # Simulate replacing "a.stl" in the (current) rev2: remove the copied
    # File row and its bytes, then seed the new content in its place.
    old_file = (
        await db_session.execute(
            select(File).where(File.revision_id == rev2.id, File.rel_path == "a.stl")
        )
    ).scalar_one()
    await db_session.delete(old_file)
    await db_session.commit()
    await seed_file(model, rev2, "a.stl", b"replaced-a")

    response = await authenticated_client.get(f"/api/revisions/{rev1.id}/diff/{rev2_id}")

    assert response.status_code == 200
    body = response.json()
    assert {e["rel_path"] for e in body["changed"]} == {"a.stl"}
    assert {e["rel_path"] for e in body["unchanged"]} == {"b.stl"}
    changed_entry = body["changed"][0]
    assert changed_entry["a"]["blob_hash"] != changed_entry["b"]["blob_hash"]


async def test_diff_reports_added_and_removed(
    authenticated_client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_file: Callable[..., Awaitable[File]],
) -> None:
    created = await _create_model(authenticated_client, "Diff Add Remove Test")
    model, rev1 = await _load_model_and_current_revision(db_session, created["id"])
    await seed_file(model, rev1, "keep.stl", b"keep-me")
    await seed_file(model, rev1, "gone.stl", b"removed-later")

    create_rev = await authenticated_client.post(f"/api/models/{created['id']}/revisions", json={})
    rev2_id = create_rev.json()["id"]
    rev2 = await db_session.get(Revision, rev2_id)

    removed_file = (
        await db_session.execute(
            select(File).where(File.revision_id == rev2.id, File.rel_path == "gone.stl")
        )
    ).scalar_one()
    await db_session.delete(removed_file)
    await db_session.commit()
    await seed_file(model, rev2, "new.stl", b"brand-new")

    response = await authenticated_client.get(f"/api/revisions/{rev1.id}/diff/{rev2_id}")

    body = response.json()
    assert {e["rel_path"] for e in body["added"]} == {"new.stl"}
    assert {e["rel_path"] for e in body["removed"]} == {"gone.stl"}
    assert {e["rel_path"] for e in body["unchanged"]} == {"keep.stl"}
    added_entry = body["added"][0]
    assert added_entry["a"] is None
    assert added_entry["b"] is not None
    removed_entry = body["removed"][0]
    assert removed_entry["a"] is not None
    assert removed_entry["b"] is None


async def test_diff_across_different_models_is_400(
    authenticated_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    model_a = await _create_model(authenticated_client, "Diff Model A")
    model_b = await _create_model(authenticated_client, "Diff Model B")

    response = await authenticated_client.get(
        f"/api/revisions/{model_a['current_revision']['id']}"
        f"/diff/{model_b['current_revision']['id']}"
    )

    assert response.status_code == 400


# ---------------------------------------------------------------------------
# file ops: current-revision-only mutability
# ---------------------------------------------------------------------------


async def test_delete_file_on_non_current_revision_is_409(
    authenticated_client: httpx.AsyncClient,
    db_session: AsyncSession,
    backend: LocalStorageBackend,
    seed_file: Callable[..., Awaitable[File]],
) -> None:
    created = await _create_model(authenticated_client, "Immutable Revision Test")
    model, rev1 = await _load_model_and_current_revision(db_session, created["id"])
    old_file = await seed_file(model, rev1, "a.stl", b"aaa")

    await authenticated_client.post(f"/api/models/{created['id']}/revisions", json={})

    response = await authenticated_client.delete(f"/api/files/{old_file.id}")

    assert response.status_code == 409
    assert backend.exists("immutable-revision-test/rev-001_initial/a.stl")


async def test_delete_file_on_current_revision_removes_row_and_bytes(
    authenticated_client: httpx.AsyncClient,
    db_session: AsyncSession,
    backend: LocalStorageBackend,
    seed_file: Callable[..., Awaitable[File]],
) -> None:
    created = await _create_model(authenticated_client, "Delete Current Test")
    model, rev1 = await _load_model_and_current_revision(db_session, created["id"])
    file = await seed_file(model, rev1, "a.stl", b"aaa")
    file_id = file.id

    response = await authenticated_client.delete(f"/api/files/{file_id}")

    assert response.status_code == 204
    # The DELETE happened through the app's own session; expire this
    # session's identity map so the check below re-queries instead of
    # returning the (locally still-cached) pre-delete object.
    db_session.expire_all()
    assert await db_session.get(File, file_id) is None
    assert not backend.exists("delete-current-test/rev-001_initial/a.stl")


async def test_delete_unknown_file_is_404(authenticated_client: httpx.AsyncClient) -> None:
    response = await authenticated_client.delete("/api/files/999999")

    assert response.status_code == 404


async def test_delete_file_still_processing_is_409(
    authenticated_client: httpx.AsyncClient,
    db_session: AsyncSession,
) -> None:
    """Deleting a row whose store job is still in flight would race
    ``store_to_backend``'s own write -- reject rather than remove a row the
    ingest task might still be about to touch.
    """
    created = await _create_model(authenticated_client, "Delete While Pending Test")
    model, rev1 = await _load_model_and_current_revision(db_session, created["id"])
    pending_file = await _seed_pending_file(
        db_session, model, rev1, "pending.stl", b"still-uploading"
    )
    file_id = pending_file.id

    response = await authenticated_client.delete(f"/api/files/{file_id}")

    assert response.status_code == 409
    db_session.expire_all()
    assert await db_session.get(File, file_id) is not None


async def test_delete_file_missing_from_backend_still_removes_row(
    authenticated_client: httpx.AsyncClient,
    db_session: AsyncSession,
    backend: LocalStorageBackend,
    seed_file: Callable[..., Awaitable[File]],
) -> None:
    """``backend.delete`` raising ``StorageKeyNotFound`` (the object is
    already gone -- a previous delete that crashed mid-way, a manual disk
    edit, ...) must not permanently block deleting the row: the DB row is
    what "should this file exist" actually means here.
    """
    created = await _create_model(authenticated_client, "Delete Missing Backend Object Test")
    model, rev1 = await _load_model_and_current_revision(db_session, created["id"])
    file = await seed_file(model, rev1, "gone.stl", b"will-be-removed-out-of-band")
    file_id = file.id
    backend.delete(file.storage_path)

    response = await authenticated_client.delete(f"/api/files/{file_id}")

    assert response.status_code == 204
    db_session.expire_all()
    assert await db_session.get(File, file_id) is None
