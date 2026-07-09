"""``relocate_model_storage`` Celery task (Workstream C task C3): moves or
replicates every file of a model, across ALL its revisions, from its current
primary backend onto a target backend.

Mirrors ``tests/test_migrate_task.py``'s structure (copy+verify semantics,
hash-mismatch handling, job state) but scoped to one model's files across
possibly more than one backend, rather than a whole-tree cutover -- and adds
the move-vs-replicate split and the idempotent-skip behavior that migrate
doesn't have.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import blake3
import pytest

from app.config import get_settings
from app.models import Blob, File, FileLocation, Model, Revision
from app.models.enums import BlobFormat, BlobKind
from app.services import jobs as jobs_service
from app.services import storage_backends as sb
from app.storage.base import WriteResult
from app.storage.config import LocalConfig
from app.storage.local import LocalStorageBackend
from app.tasks.relocate import relocate_model_storage

pytestmark = pytest.mark.usefixtures("library_root", "data_dir")


async def _make_backend(
    db_session, tmp_path, name: str, *, is_default: bool = False
) -> tuple[sb.StorageBackendRow, LocalStorageBackend]:
    settings = get_settings()
    root = tmp_path / name
    row = await sb.create_backend(
        db_session, settings, name, LocalConfig(root=str(root)), is_default=is_default
    )
    return row, LocalStorageBackend(root)


async def _seed_model_with_file(
    db_session,
    source_backend: LocalStorageBackend,
    source_backend_id: int,
    *,
    content: bytes = b"hello-world",
    rel_path: str = "part.stl",
    slug: str = "widget",
) -> tuple[Model, Revision, File]:
    """Plant a Model/Revision/Blob/File chain whose bytes already live on
    ``source_backend`` -- mirroring what a C2 write path (ingest/scanner)
    leaves behind: ``backend_id`` stamped and a matching ``file_locations``
    row, not just bytes on disk.
    """
    model = Model(slug=slug, name=slug)
    db_session.add(model)
    await db_session.flush()
    revision = Revision(model_id=model.id, number=1, name="initial", dir_name="rev-001_initial")
    db_session.add(revision)
    await db_session.flush()

    digest = blake3.blake3(content).hexdigest()
    blob = Blob(hash=digest, size=len(content), kind=BlobKind.MESH, format=BlobFormat.STL)
    db_session.add(blob)
    await db_session.flush()

    storage_path = f"{model.slug}/{revision.dir_name}/{rel_path}"
    source_backend.write(storage_path, [content])

    now = datetime.now(UTC)
    file = File(
        revision_id=revision.id,
        blob_hash=digest,
        rel_path=rel_path,
        storage_path=storage_path,
        backend_id=source_backend_id,
        verified_at=now,
    )
    db_session.add(file)
    await db_session.flush()
    db_session.add(FileLocation(file_id=file.id, backend_id=source_backend_id, verified_at=now))
    await db_session.commit()
    await db_session.refresh(file)
    return model, revision, file


async def _add_revision_file(
    db_session,
    model: Model,
    source_backend: LocalStorageBackend,
    source_backend_id: int,
    *,
    number: int,
    content: bytes,
    rel_path: str = "part.stl",
) -> tuple[Revision, File]:
    dir_name = f"rev-{number:03d}_v{number}"
    revision = Revision(model_id=model.id, number=number, name=f"v{number}", dir_name=dir_name)
    db_session.add(revision)
    await db_session.flush()

    digest = blake3.blake3(content).hexdigest()
    blob = await db_session.get(Blob, digest)
    if blob is None:
        blob = Blob(hash=digest, size=len(content), kind=BlobKind.MESH, format=BlobFormat.STL)
        db_session.add(blob)
        await db_session.flush()

    storage_path = f"{model.slug}/{dir_name}/{rel_path}"
    source_backend.write(storage_path, [content])

    now = datetime.now(UTC)
    file = File(
        revision_id=revision.id,
        blob_hash=digest,
        rel_path=rel_path,
        storage_path=storage_path,
        backend_id=source_backend_id,
        verified_at=now,
    )
    db_session.add(file)
    await db_session.flush()
    db_session.add(FileLocation(file_id=file.id, backend_id=source_backend_id, verified_at=now))
    await db_session.commit()
    await db_session.refresh(file)
    return revision, file


async def _seed_relocate_job(db_session, model_id: int) -> str:
    token = uuid.uuid4()
    await jobs_service.create_job(
        db_session,
        id=token,
        type="relocate_model_storage",
        subject_type="model",
        subject_id=model_id,
    )
    return str(token)


# ---------------------------------------------------------------------------
# move
# ---------------------------------------------------------------------------


async def test_relocate_move_copies_verifies_then_deletes_source(db_session, tmp_path) -> None:
    source_row, source = await _make_backend(db_session, tmp_path, "source", is_default=True)
    target_row, target = await _make_backend(db_session, tmp_path, "target")
    model, _revision, file = await _seed_model_with_file(db_session, source, source_row.id)
    job_id = await _seed_relocate_job(db_session, model.id)

    relocate_model_storage(job_id, model.id, target_row.id, "move")

    assert b"".join(target.read(file.storage_path)) == b"hello-world"
    assert not source.exists(file.storage_path)

    await db_session.refresh(file)
    assert file.backend_id == target_row.id

    target_loc = await db_session.get(FileLocation, (file.id, target_row.id))
    assert target_loc is not None
    assert target_loc.verified_at is not None
    assert await db_session.get(FileLocation, (file.id, source_row.id)) is None

    job = await jobs_service.get_job_or_404(db_session, uuid.UUID(job_id))
    await db_session.refresh(job)
    assert job.state == "done"


async def test_relocate_move_across_all_revisions_of_the_model(db_session, tmp_path) -> None:
    source_row, source = await _make_backend(db_session, tmp_path, "source", is_default=True)
    target_row, target = await _make_backend(db_session, tmp_path, "target")
    model, _rev1, file1 = await _seed_model_with_file(
        db_session, source, source_row.id, content=b"rev1-bytes"
    )
    _rev2, file2 = await _add_revision_file(
        db_session, model, source, source_row.id, number=2, content=b"rev2-bytes"
    )
    job_id = await _seed_relocate_job(db_session, model.id)

    relocate_model_storage(job_id, model.id, target_row.id, "move")

    assert b"".join(target.read(file1.storage_path)) == b"rev1-bytes"
    assert b"".join(target.read(file2.storage_path)) == b"rev2-bytes"
    assert not source.exists(file1.storage_path)
    assert not source.exists(file2.storage_path)

    await db_session.refresh(file1)
    await db_session.refresh(file2)
    assert file1.backend_id == target_row.id
    assert file2.backend_id == target_row.id


async def test_relocate_move_is_idempotent_when_rerun_against_the_same_target(
    db_session, tmp_path
) -> None:
    source_row, source = await _make_backend(db_session, tmp_path, "source", is_default=True)
    target_row, target = await _make_backend(db_session, tmp_path, "target")
    model, _revision, file = await _seed_model_with_file(db_session, source, source_row.id)
    job_id = await _seed_relocate_job(db_session, model.id)
    relocate_model_storage(job_id, model.id, target_row.id, "move")
    await db_session.refresh(file)
    assert file.backend_id == target_row.id

    # Re-running relocate to the SAME target must skip the file entirely
    # (current_backend_id == target_backend_id) -- if it instead tried to
    # re-read the OLD source, that source object is already gone (deleted by
    # the first run), so a `StorageKeyNotFound` would fail this job.
    job_id_2 = await _seed_relocate_job(db_session, model.id)
    relocate_model_storage(job_id_2, model.id, target_row.id, "move")

    job2 = await jobs_service.get_job_or_404(db_session, uuid.UUID(job_id_2))
    await db_session.refresh(job2)
    assert job2.state == "done"
    assert b"".join(target.read(file.storage_path)) == b"hello-world"


# ---------------------------------------------------------------------------
# replicate
# ---------------------------------------------------------------------------


async def test_relocate_replicate_keeps_both_locations_and_leaves_backend_id(
    db_session, tmp_path
) -> None:
    source_row, source = await _make_backend(db_session, tmp_path, "source", is_default=True)
    target_row, target = await _make_backend(db_session, tmp_path, "target")
    model, _revision, file = await _seed_model_with_file(db_session, source, source_row.id)
    job_id = await _seed_relocate_job(db_session, model.id)

    relocate_model_storage(job_id, model.id, target_row.id, "replicate")

    assert b"".join(target.read(file.storage_path)) == b"hello-world"
    assert source.exists(file.storage_path)  # source untouched

    await db_session.refresh(file)
    assert file.backend_id == source_row.id  # primary unchanged

    source_loc = await db_session.get(FileLocation, (file.id, source_row.id))
    target_loc = await db_session.get(FileLocation, (file.id, target_row.id))
    assert source_loc is not None
    assert target_loc is not None
    assert target_loc.verified_at is not None

    job = await jobs_service.get_job_or_404(db_session, uuid.UUID(job_id))
    await db_session.refresh(job)
    assert job.state == "done"


async def test_relocate_replicate_rerun_is_a_no_op_with_location_ensured(
    db_session, tmp_path
) -> None:
    source_row, source = await _make_backend(db_session, tmp_path, "source", is_default=True)
    target_row, target = await _make_backend(db_session, tmp_path, "target")
    model, _revision, file = await _seed_model_with_file(db_session, source, source_row.id)

    job_id = await _seed_relocate_job(db_session, model.id)
    relocate_model_storage(job_id, model.id, target_row.id, "replicate")

    job_id_2 = await _seed_relocate_job(db_session, model.id)
    relocate_model_storage(job_id_2, model.id, target_row.id, "replicate")

    job2 = await jobs_service.get_job_or_404(db_session, uuid.UUID(job_id_2))
    await db_session.refresh(job2)
    assert job2.state == "done"

    await db_session.refresh(file)
    assert file.backend_id == source_row.id
    assert await db_session.get(FileLocation, (file.id, source_row.id)) is not None
    assert await db_session.get(FileLocation, (file.id, target_row.id)) is not None


# ---------------------------------------------------------------------------
# hash mismatch
# ---------------------------------------------------------------------------


async def test_relocate_hash_mismatch_aborts_file_without_deleting_source_and_fails_job(
    db_session, tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source_row, source = await _make_backend(db_session, tmp_path, "source", is_default=True)
    target_row, _target = await _make_backend(db_session, tmp_path, "target")
    model, _revision, file = await _seed_model_with_file(db_session, source, source_row.id)
    job_id = await _seed_relocate_job(db_session, model.id)

    original_write = LocalStorageBackend.write

    def _wrong_hash_write(self, key, chunks):
        result = original_write(self, key, chunks)
        return WriteResult(hash="0" * 64, size=result.size)

    # relocate never calls `.write()` on the SOURCE backend (only `.read`/
    # `.delete`), so patching the whole class only affects the target copy
    # here.
    monkeypatch.setattr(LocalStorageBackend, "write", _wrong_hash_write)

    with pytest.raises(RuntimeError, match="hash mismatch"):
        relocate_model_storage(job_id, model.id, target_row.id, "move")

    assert source.exists(file.storage_path)
    await db_session.refresh(file)
    assert file.backend_id == source_row.id

    job = await jobs_service.get_job_or_404(db_session, uuid.UUID(job_id))
    await db_session.refresh(job)
    assert job.state == "failed"
    assert "hash mismatch" in job.error


# ---------------------------------------------------------------------------
# misc
# ---------------------------------------------------------------------------


async def test_relocate_with_no_files_marks_job_done(db_session, tmp_path) -> None:
    target_row, _target = await _make_backend(db_session, tmp_path, "target", is_default=True)
    model = Model(slug="empty-model", name="Empty")
    db_session.add(model)
    await db_session.commit()
    await db_session.refresh(model)

    job_id = await _seed_relocate_job(db_session, model.id)
    relocate_model_storage(job_id, model.id, target_row.id, "replicate")

    job = await jobs_service.get_job_or_404(db_session, uuid.UUID(job_id))
    await db_session.refresh(job)
    assert job.state == "done"


async def test_relocate_invalid_mode_marks_job_failed(db_session, tmp_path) -> None:
    source_row, source = await _make_backend(db_session, tmp_path, "source", is_default=True)
    model, _revision, _file = await _seed_model_with_file(db_session, source, source_row.id)
    job_id = await _seed_relocate_job(db_session, model.id)

    with pytest.raises(ValueError, match="unknown relocate mode"):
        relocate_model_storage(job_id, model.id, source_row.id, "bogus")

    job = await jobs_service.get_job_or_404(db_session, uuid.UUID(job_id))
    await db_session.refresh(job)
    assert job.state == "failed"


async def test_relocate_skips_a_file_deleted_since_the_job_was_enqueued(
    db_session, tmp_path
) -> None:
    source_row, source = await _make_backend(db_session, tmp_path, "source", is_default=True)
    target_row, _target = await _make_backend(db_session, tmp_path, "target")
    model, _revision, file = await _seed_model_with_file(db_session, source, source_row.id)
    job_id = await _seed_relocate_job(db_session, model.id)

    await db_session.delete(file)
    await db_session.commit()

    relocate_model_storage(job_id, model.id, target_row.id, "move")  # must not raise

    job = await jobs_service.get_job_or_404(db_session, uuid.UUID(job_id))
    await db_session.refresh(job)
    assert job.state == "done"
