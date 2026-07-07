"""``scan_library`` reconciler (SPEC "Rescan/reconcile"; Task 5 brief).

One test per row of the SPEC decision table, driving ``scanner.run_scan``
directly against a real local backend + the real Postgres testcontainer.
``run_scan`` takes a SYNC ``Session`` (worker world, see ``app.tasks.base``)
while the fixtures seed through the ASYNC ``db_session`` -- exactly like
``tests/test_jobs_api.py``'s Celery-task tests, any row touched by both
sides needs an explicit ``await db_session.refresh(...)`` after the sync
side commits, since the two sessions/connections have independent identity
maps.
"""

from __future__ import annotations

import json
import os
from collections.abc import Awaitable, Callable

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models import Blob, File, Job, Model, Revision, ScanRun
from app.services import layout, scanner
from app.storage.errors import StorageKeyNotFound
from app.storage.local import LocalStorageBackend
from app.tasks import base

pytestmark = pytest.mark.usefixtures("library_root", "redis_url")


async def _create_model_and_revision(
    db_session: AsyncSession, slug: str, name: str
) -> tuple[Model, Revision]:
    model = Model(slug=slug, name=name)
    db_session.add(model)
    await db_session.flush()
    revision = Revision(model_id=model.id, number=1, name="initial", dir_name="rev-001_initial")
    db_session.add(revision)
    await db_session.flush()
    model.current_revision_id = revision.id
    await db_session.commit()
    await db_session.refresh(model)
    await db_session.refresh(revision)
    return model, revision


def _create_scan_run() -> int:
    with base.sync_session() as session:
        scan_run = ScanRun(state="running")
        session.add(scan_run)
        session.commit()
        session.refresh(scan_run)
        return scan_run.id


def _run_scan(backend: LocalStorageBackend) -> ScanRun:
    settings = get_settings()
    scan_run_id = _create_scan_run()
    with base.sync_session() as session:
        scanner.run_scan(session, settings, backend, scan_run_id)
    with base.sync_session() as session:
        scan_run = session.get(ScanRun, scan_run_id)
        session.expunge(scan_run)
        return scan_run


async def _sync_mtime(db_session: AsyncSession, backend: LocalStorageBackend, file: File) -> None:
    """Backfill ``file.mtime`` to match what's really on disk, so a
    known/unchanged file gets the cheap size+mtime match instead of always
    falling into the "changed" (rehash) branch on its very first scan.

    Uses the shared ``conftest.seed_file`` fixture, which (like the real
    upload path pre-Task-5) never itself sets ``mtime`` -- only a completed
    ``store_to_backend``/scan does.
    """
    stat = backend.stat(file.storage_path)
    file.mtime = stat.mtime
    await db_session.commit()


# ---------------------------------------------------------------------------
# 1. Known path, unchanged
# ---------------------------------------------------------------------------


async def test_known_unchanged_touches_verified_at(
    db_session: AsyncSession,
    backend: LocalStorageBackend,
    seed_file: Callable[..., Awaitable[File]],
) -> None:
    model, revision = await _create_model_and_revision(db_session, "widget", "Widget")
    file = await seed_file(model, revision, "part.stl", b"unchanged-bytes")
    await _sync_mtime(db_session, backend, file)
    file.verified_at = None
    await db_session.commit()
    original_blob_hash = file.blob_hash

    scan_run = _run_scan(backend)

    await db_session.refresh(file)
    assert file.verified_at is not None
    assert file.blob_hash == original_blob_hash
    assert scan_run.files_hashed == 0
    assert scan_run.files_seen == 1
    assert scan_run.report["verified"] == 1
    assert scan_run.state == "done"
    assert scan_run.finished_at is not None


# ---------------------------------------------------------------------------
# 2. Known path, changed
# ---------------------------------------------------------------------------


async def test_known_changed_content_repoints_blob_and_reports(
    db_session: AsyncSession,
    backend: LocalStorageBackend,
    seed_file: Callable[..., Awaitable[File]],
) -> None:
    model, revision = await _create_model_and_revision(db_session, "widget", "Widget")
    file = await seed_file(model, revision, "part.stl", b"original-bytes")
    await _sync_mtime(db_session, backend, file)
    old_hash = file.blob_hash

    # Out-of-band edit: overwrite the same storage_path with different bytes,
    # simulating a user editing the file directly on disk.
    backend.write(file.storage_path, [b"edited-bytes-totally-different"])

    scan_run = _run_scan(backend)

    await db_session.refresh(file)
    assert file.blob_hash != old_hash
    new_blob = await db_session.get(Blob, file.blob_hash)
    assert new_blob is not None
    assert new_blob.size == len(b"edited-bytes-totally-different")
    assert scan_run.files_hashed == 1
    assert scan_run.relinked == 0
    assert scan_run.adopted == 0
    changed = scan_run.report["changed"]
    assert len(changed) == 1
    assert changed[0]["file_id"] == file.id
    assert changed[0]["old_hash"] == old_hash
    assert changed[0]["new_hash"] == file.blob_hash

    # Best-effort pipeline dispatch happened for the new blob.
    jobs = (
        (
            await db_session.execute(
                select(Job).where(Job.subject_type == "file", Job.subject_id == file.id)
            )
        )
        .scalars()
        .all()
    )
    assert any(j.type == "extract_metadata" for j in jobs)


# ---------------------------------------------------------------------------
# 3. Unknown path, matching hash -> relink (headline test)
# ---------------------------------------------------------------------------


async def test_unknown_path_matching_hash_relinks_moved_file(
    db_session: AsyncSession,
    backend: LocalStorageBackend,
    library_root,
    seed_file: Callable[..., Awaitable[File]],
) -> None:
    moved_model, moved_revision = await _create_model_and_revision(db_session, "widget", "Widget")
    moved_file = await seed_file(moved_model, moved_revision, "part.stl", b"moved-bytes")
    await _sync_mtime(db_session, backend, moved_file)

    # An entirely separate, untouched model+file elsewhere in the tree --
    # proves the scan only re-hashes the moved file, "not the whole tree".
    stay_model, stay_revision = await _create_model_and_revision(db_session, "gadget", "Gadget")
    stay_file = await seed_file(stay_model, stay_revision, "stay.stl", b"untouched-bytes")
    await _sync_mtime(db_session, backend, stay_file)

    old_path = moved_file.storage_path
    os.rename(library_root / "widget", library_root / "widget-moved")
    new_path = old_path.replace("widget/", "widget-moved/", 1)

    scan_run = _run_scan(backend)

    await db_session.refresh(moved_file)
    await db_session.refresh(stay_file)

    assert moved_file.storage_path == new_path
    assert scan_run.relinked == 1
    assert scan_run.files_hashed == 1  # only the moved file, not stay.stl
    assert scan_run.missing == 0
    relinked = scan_run.report["relinked"]
    assert len(relinked) == 1
    assert relinked[0]["file_id"] == moved_file.id
    assert relinked[0]["from"] == old_path
    assert relinked[0]["to"] == new_path
    assert relinked[0]["hash"] == moved_file.blob_hash

    # The untouched file was cheaply verified, not rehashed or relinked.
    assert stay_file.storage_path == "gadget/rev-001_initial/stay.stl"
    assert scan_run.report["verified"] == 1


# ---------------------------------------------------------------------------
# 3b. Task 5 fix-wave Finding 1 regression: relink must only claim a row
#     from the CONFIRMED-missing set, never a not-yet-walked row whose own
#     on-disk file is still present.
# ---------------------------------------------------------------------------


async def test_unknown_path_relink_only_claims_confirmed_missing_row(
    db_session: AsyncSession,
    backend: LocalStorageBackend,
    library_root,
    seed_file: Callable[..., Awaitable[File]],
) -> None:
    """Two byte-identical files sharing a basename ("part.stl") under two
    different models. Moving only one must relink THAT file and must never
    touch the other, still-present one -- even though, mid-walk, the
    still-present row can look like an equally good relink candidate simply
    because the walk hasn't reached its own (unchanged) path yet.

    The pre-fix single-pass algorithm broke the hash+tail tie by lowest
    ``File.id`` among ALL not-yet-visited rows, not just confirmed-missing
    ones -- so creating the stay-put model ("b") FIRST (giving it the lower
    id) and the moved model ("a") SECOND reliably reproduces the bug: the
    buggy code relinks "b" (still present) to "a"'s moved location, then
    reports "a" (the file that actually moved) as missing.
    """
    stay_model, stay_revision = await _create_model_and_revision(db_session, "b", "B")
    stay_file = await seed_file(stay_model, stay_revision, "part.stl", b"identical-bytes")
    await _sync_mtime(db_session, backend, stay_file)

    moved_model, moved_revision = await _create_model_and_revision(db_session, "a", "A")
    moved_file = await seed_file(moved_model, moved_revision, "part.stl", b"identical-bytes")
    await _sync_mtime(db_session, backend, moved_file)

    old_path = moved_file.storage_path
    os.rename(library_root / "a", library_root / "a-moved")
    new_path = old_path.replace("a/", "a-moved/", 1)

    scan_run = _run_scan(backend)

    await db_session.refresh(moved_file)
    await db_session.refresh(stay_file)

    # The file that actually moved is the one that gets relinked.
    assert moved_file.storage_path == new_path
    assert scan_run.relinked == 1
    relinked = scan_run.report["relinked"]
    assert len(relinked) == 1
    assert relinked[0]["file_id"] == moved_file.id
    assert relinked[0]["from"] == old_path
    assert relinked[0]["to"] == new_path

    # The still-present file is untouched: not relinked away from its own
    # path, not reported missing, not duplicated into a false adopted draft.
    assert stay_file.storage_path == "b/rev-001_initial/part.stl"
    assert scan_run.missing == 0
    assert scan_run.report["missing"] == []
    assert scan_run.adopted == 0


# ---------------------------------------------------------------------------
# 4. Unknown path, unknown hash, doesn't fit any model -> adopt as draft
# ---------------------------------------------------------------------------


async def test_unknown_folder_adopts_as_draft_model_review_me(
    db_session: AsyncSession, backend: LocalStorageBackend
) -> None:
    backend.write("random-drop/thing.stl", [b"dropped-bytes"])

    scan_run = _run_scan(backend)

    model = (
        await db_session.execute(select(Model).where(Model.slug == "random-drop"))
    ).scalar_one_or_none()
    assert model is not None
    assert model.review_state == "adopted"
    assert model.current_revision_id is not None

    revision = await db_session.get(Revision, model.current_revision_id)
    assert revision.number == 1
    assert revision.dir_name == "rev-001_initial"

    file = (
        await db_session.execute(select(File).where(File.revision_id == revision.id))
    ).scalar_one()
    assert file.storage_path == "random-drop/thing.stl"
    assert file.rel_path == "thing.stl"

    sidecar_bytes = b"".join(backend.read("random-drop/.3dmm.json"))
    sidecar = json.loads(sidecar_bytes)
    assert sidecar == {"model_id": model.id, "slug": "random-drop", "name": "random-drop"}

    assert scan_run.adopted == 1
    adopted = scan_run.report["adopted"]
    assert len(adopted) == 1
    assert adopted[0] == {
        "model_id": model.id,
        "slug": "random-drop",
        "revision_id": revision.id,
        "files": ["thing.stl"],
    }


# ---------------------------------------------------------------------------
# 5. Unknown path, unknown hash, fits an existing model+revision -> attach
# ---------------------------------------------------------------------------


async def test_unknown_path_under_existing_model_attaches_to_revision(
    db_session: AsyncSession, backend: LocalStorageBackend
) -> None:
    model, revision = await _create_model_and_revision(db_session, "widget", "Widget")
    backend.write(layout.file_key("widget", "rev-001_initial", "extra.stl"), [b"extra-bytes"])

    scan_run = _run_scan(backend)

    files = (
        (await db_session.execute(select(File).where(File.revision_id == revision.id)))
        .scalars()
        .all()
    )
    assert len(files) == 1
    assert files[0].rel_path == "extra.stl"
    assert files[0].storage_path == "widget/rev-001_initial/extra.stl"

    model_count = (await db_session.execute(select(Model))).scalars().all()
    assert len(model_count) == 1  # no new model created

    assert scan_run.adopted == 1
    assert scan_run.report["adopted"][0]["model_id"] == model.id
    assert scan_run.report["adopted"][0]["slug"] == "widget"
    assert scan_run.report["adopted"][0]["revision_id"] == revision.id


# ---------------------------------------------------------------------------
# 5b. Unknown path, KNOWN hash (duplicate content), fits existing model,
#     no relink candidate -> adopted duplicate (distinct branch from 5).
# ---------------------------------------------------------------------------


async def test_unknown_path_duplicate_hash_adopts_as_new_file(
    db_session: AsyncSession,
    backend: LocalStorageBackend,
    seed_file: Callable[..., Awaitable[File]],
) -> None:
    model, revision = await _create_model_and_revision(db_session, "widget", "Widget")
    original = await seed_file(model, revision, "part.stl", b"shared-content")
    await _sync_mtime(db_session, backend, original)

    # Same bytes, different filename, dropped directly with no File row --
    # not a relink candidate (rel_path tail doesn't match "part.stl").
    backend.write(
        layout.file_key("widget", "rev-001_initial", "duplicate.stl"), [b"shared-content"]
    )

    scan_run = _run_scan(backend)

    blobs = (await db_session.execute(select(Blob))).scalars().all()
    assert len(blobs) == 1  # no new blob -- same content, deduped

    files = (
        (await db_session.execute(select(File).where(File.revision_id == revision.id)))
        .scalars()
        .all()
    )
    assert {f.rel_path for f in files} == {"part.stl", "duplicate.stl"}

    assert scan_run.adopted == 1
    assert scan_run.relinked == 0
    assert scan_run.missing == 0


# ---------------------------------------------------------------------------
# 6. Snapshot path never seen -> missing (row + object untouched, never
#    deleted -- the CRITICAL never-delete invariant).
# ---------------------------------------------------------------------------


async def test_missing_db_path_marked_missing_never_deleted(
    db_session: AsyncSession,
    backend: LocalStorageBackend,
    library_root,
    seed_file: Callable[..., Awaitable[File]],
) -> None:
    model, revision = await _create_model_and_revision(db_session, "widget", "Widget")
    file = await seed_file(model, revision, "part.stl", b"soon-to-vanish")
    await _sync_mtime(db_session, backend, file)
    file_id = file.id
    storage_path = file.storage_path

    # Remove the bytes directly on disk (bypassing the backend entirely) --
    # simulates the user deleting the file out-of-band.
    (library_root / storage_path).unlink()

    scan_run = _run_scan(backend)

    reloaded = await db_session.get(File, file_id)
    assert reloaded is not None  # row NEVER deleted
    assert reloaded.storage_path == storage_path  # untouched
    assert reloaded.blob_hash == file.blob_hash  # untouched

    assert scan_run.missing == 1
    missing = scan_run.report["missing"]
    assert len(missing) == 1
    assert missing[0]["file_id"] == file_id
    assert missing[0]["storage_path"] == storage_path
    assert missing[0]["model_slug"] == "widget"


# ---------------------------------------------------------------------------
# 7. Counters + report persisted on the ScanRun row.
# ---------------------------------------------------------------------------


async def test_scan_run_report_and_counters_persisted(
    db_session: AsyncSession,
    backend: LocalStorageBackend,
    library_root,
    seed_file: Callable[..., Awaitable[File]],
) -> None:
    model, revision = await _create_model_and_revision(db_session, "widget", "Widget")

    verified_file = await seed_file(model, revision, "verified.stl", b"stays-put")
    await _sync_mtime(db_session, backend, verified_file)

    moved_file = await seed_file(model, revision, "moved.stl", b"will-move")
    await _sync_mtime(db_session, backend, moved_file)

    missing_file = await seed_file(model, revision, "gone.stl", b"will-vanish")
    await _sync_mtime(db_session, backend, missing_file)

    # Move moved.stl to an unknown path, preserving its filename (the
    # relink match is by hash + matching `rel_path` tail) -- a relink
    # candidate.
    backend.copy(moved_file.storage_path, "widget/rev-002_elsewhere/moved.stl")
    (library_root / moved_file.storage_path).unlink()

    # Delete gone.stl's bytes (missing candidate).
    (library_root / missing_file.storage_path).unlink()

    # Drop a brand new adopted file.
    backend.write("widget/rev-001_initial/new-drop.stl", [b"brand-new-bytes"])

    scan_run = _run_scan(backend)

    assert scan_run.state == "done"
    assert scan_run.finished_at is not None
    assert scan_run.files_seen == 3  # verified + moved-elsewhere + new-drop
    assert scan_run.relinked == 1
    assert scan_run.adopted == 1
    assert scan_run.missing == 1
    report = scan_run.report
    assert report["verified"] == 1
    assert len(report["relinked"]) == 1
    assert len(report["adopted"]) == 1
    assert len(report["missing"]) == 1
    assert report["changed"] == []


# ---------------------------------------------------------------------------
# Stale sidecar refresh (Global Constraints carried item: the scanner
# refreshes stale sidecars during reconcile).
# ---------------------------------------------------------------------------


async def test_stale_sidecar_refreshed_during_scan(
    db_session: AsyncSession, backend: LocalStorageBackend
) -> None:
    model, _revision = await _create_model_and_revision(db_session, "widget", "New Name")
    # Simulate a sidecar written before a rename (the pre-Task-5 bug this
    # Global Constraints item calls out): stale content still says "Old Name".
    layout.write_sidecar(backend, model.id, "widget", "Old Name")

    _run_scan(backend)

    sidecar_bytes = b"".join(backend.read("widget/.3dmm.json"))
    sidecar = json.loads(sidecar_bytes)
    assert sidecar == {"model_id": model.id, "slug": "widget", "name": "New Name"}


# ---------------------------------------------------------------------------
# Task 5 fix-wave Finding 3: one unreadable file must not abort the scan.
# ---------------------------------------------------------------------------


async def test_unreadable_file_recorded_as_error_and_scan_continues(
    db_session: AsyncSession,
    backend: LocalStorageBackend,
    seed_file: Callable[..., Awaitable[File]],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A TOCTOU deletion (or a transient SMB/S3 read error) on one file's
    re-hash must not discard the whole run's reconcile progress -- it's
    recorded in ``report["errors"]`` and the scan finishes ``done``, with
    every other file still reconciled normally.
    """
    model, revision = await _create_model_and_revision(db_session, "widget", "Widget")
    ok_file = await seed_file(model, revision, "ok.stl", b"fine-bytes")
    await _sync_mtime(db_session, backend, ok_file)

    # A brand-new, unknown-path file whose read will fail during the pass-2
    # re-hash -- simulates the file vanishing (or a backend hiccup) between
    # `walk()` discovering the key and the scanner actually reading it.
    broken_key = "widget/rev-001_initial/broken.stl"
    backend.write(broken_key, [b"will-fail-to-read"])

    real_read = backend.read

    def flaky_read(key: str, *args: object, **kwargs: object):
        if key == broken_key:
            raise StorageKeyNotFound(key)
        return real_read(key, *args, **kwargs)

    monkeypatch.setattr(backend, "read", flaky_read)

    scan_run = _run_scan(backend)

    assert scan_run.state == "done"
    assert scan_run.finished_at is not None

    errors = scan_run.report["errors"]
    assert len(errors) == 1
    assert errors[0]["storage_path"] == broken_key
    assert errors[0]["error"]

    # The broken file wasn't counted toward any outcome.
    assert scan_run.adopted == 0
    assert scan_run.relinked == 0
    assert scan_run.missing == 0

    # The healthy file was still reconciled normally.
    await db_session.refresh(ok_file)
    assert ok_file.verified_at is not None
    assert scan_run.report["verified"] == 1
