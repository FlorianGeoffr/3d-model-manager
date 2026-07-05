"""Job listing, retry semantics, and ``store_to_backend`` failure handling
(SPEC "Processing pipeline", Task 6 interface decisions).
"""

from __future__ import annotations

import logging
import uuid
from pathlib import Path

import blake3
import httpx
import pytest

from app.config import get_settings
from app.models import Blob, File, Model, Revision
from app.models.enums import BlobFormat, BlobKind
from app.services import events, spool
from app.services import jobs as jobs_service
from app.storage.local import LocalStorageBackend
from app.tasks import base
from app.tasks.ingest import store_to_backend

pytestmark = pytest.mark.usefixtures("library_root", "data_dir")


async def _create_model(client: httpx.AsyncClient, name: str) -> dict:
    response = await client.post("/api/models", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


async def _upload(client: httpx.AsyncClient, *, model_id: int, revision_id: int) -> httpx.Response:
    return await client.put(
        "/api/uploads",
        params={"model_id": model_id, "revision_id": revision_id, "rel_path": "part.stl"},
        content=b"some-real-bytes",
    )


async def _seed_mismatched_job(db_session) -> tuple[str, str, str]:
    """Directly build a model/revision/blob/file/job/spool tuple where the
    file's ``blob_hash`` deliberately does NOT match the spool file's actual
    content, so ``store_to_backend`` hits its hash-verification failure path
    without needing to race the (synchronous, eager) upload endpoint.

    Returns ``(job_id, file_id, spool_path)`` as strings.
    """
    model = Model(slug="mismatch-test", name="Mismatch Test")
    db_session.add(model)
    await db_session.flush()
    revision = Revision(model_id=model.id, number=1, name="initial", dir_name="rev-001_initial")
    db_session.add(revision)
    await db_session.flush()
    model.current_revision_id = revision.id

    wrong_hash = "0" * 64
    blob = Blob(hash=wrong_hash, size=20, kind=BlobKind.MESH, format=BlobFormat.STL)
    db_session.add(blob)
    await db_session.flush()

    storage_path = f"{model.slug}/{revision.dir_name}/part.stl"
    file = File(
        revision_id=revision.id,
        blob_hash=wrong_hash,
        rel_path="part.stl",
        storage_path=storage_path,
        verified_at=None,
    )
    db_session.add(file)
    await db_session.commit()
    await db_session.refresh(file)

    settings = get_settings()
    spool.ensure_spool_dir(settings)
    token = uuid.uuid4()
    path = spool.spool_path(settings, token)
    path.write_bytes(b"actual-spool-content")

    job = await jobs_service.create_job(
        db_session, id=token, type="store_to_backend", subject_type="file", subject_id=file.id
    )
    return str(job.id), file.id, str(path)


async def test_store_to_backend_hash_mismatch_marks_job_failed_and_keeps_spool(
    db_session,
) -> None:
    job_id, file_id, path_str = await _seed_mismatched_job(db_session)

    store_to_backend(job_id, file_id, path_str)

    # The task mutated rows through its own SYNC session (app.tasks.base);
    # refresh explicitly so this async session doesn't serve stale
    # identity-map state.
    job = await jobs_service.get_job_or_404(db_session, uuid.UUID(job_id))
    await db_session.refresh(job)
    file = await db_session.get(File, file_id)
    await db_session.refresh(file)

    assert job.state == "failed"
    assert "hash mismatch" in job.error
    assert file.verified_at is None
    assert Path(path_str).exists()


async def _seed_matching_job(db_session, *, slug: str, content: bytes) -> tuple[str, int, str]:
    """Like ``_seed_mismatched_job`` above, but the file's ``blob_hash``
    correctly matches the spool content, so ``store_to_backend`` passes its
    hash-verification and reaches the post-write existence/blob-hash check
    (the belt-and-suspenders guard against a replace-upload race).
    """
    model = Model(slug=slug, name=slug)
    db_session.add(model)
    await db_session.flush()
    revision = Revision(model_id=model.id, number=1, name="initial", dir_name="rev-001_initial")
    db_session.add(revision)
    await db_session.flush()
    model.current_revision_id = revision.id

    digest = blake3.blake3(content).hexdigest()
    blob = Blob(hash=digest, size=len(content), kind=BlobKind.MESH, format=BlobFormat.STL)
    db_session.add(blob)
    await db_session.flush()

    storage_path = f"{model.slug}/{revision.dir_name}/part.stl"
    file = File(
        revision_id=revision.id,
        blob_hash=digest,
        rel_path="part.stl",
        storage_path=storage_path,
        verified_at=None,
    )
    db_session.add(file)
    await db_session.commit()
    await db_session.refresh(file)

    settings = get_settings()
    spool.ensure_spool_dir(settings)
    token = uuid.uuid4()
    path = spool.spool_path(settings, token)
    path.write_bytes(content)

    job = await jobs_service.create_job(
        db_session, id=token, type="store_to_backend", subject_type="file", subject_id=file.id
    )
    return str(job.id), file.id, str(path)


async def test_store_to_backend_file_deleted_mid_write_marks_job_failed_as_superseded(
    db_session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A ``replace=true`` re-upload can delete this job's ``File`` row (and
    dispatch its own job) while ``backend.write`` is still running here.
    Marking this job ``done``/verified afterward would let this write's
    (possibly stale) bytes silently win regardless of which job the DB
    considers current -- the post-write check must catch the row being gone
    and fail cleanly instead.
    """
    content = b"soon-to-be-superseded-bytes"
    job_id, file_id, path_str = await _seed_matching_job(
        db_session, slug="supersede-delete-test", content=content
    )

    original_write = LocalStorageBackend.write

    def write_then_delete_row(self, key, chunks):
        result = original_write(self, key, chunks)
        # Simulate a concurrent replace=true re-upload winning the race
        # while the write above was in flight: it deletes this File row.
        with base.sync_session() as sync_session:
            row = sync_session.get(File, file_id)
            sync_session.delete(row)
            sync_session.commit()
        return result

    monkeypatch.setattr(LocalStorageBackend, "write", write_then_delete_row)

    store_to_backend(job_id, file_id, path_str)

    job = await jobs_service.get_job_or_404(db_session, uuid.UUID(job_id))
    await db_session.refresh(job)
    assert job.state == "failed"
    assert "superseded" in job.error
    assert Path(path_str).exists()  # spool kept on disk, same as the hash-mismatch path
    assert await db_session.get(File, file_id) is None


async def test_store_to_backend_file_repointed_mid_write_marks_job_failed_as_superseded(
    db_session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Same race, but the row survives and is instead repointed at a
    different blob (rather than deleted) before this job's write finishes --
    the row-still-exists check alone wouldn't catch this; the blob_hash
    comparison is what does.
    """
    content = b"soon-to-be-repointed-bytes"
    job_id, file_id, path_str = await _seed_matching_job(
        db_session, slug="supersede-repoint-test", content=content
    )
    other_hash = blake3.blake3(b"a-completely-different-blob").hexdigest()

    original_write = LocalStorageBackend.write

    def write_then_repoint_row(self, key, chunks):
        result = original_write(self, key, chunks)
        with base.sync_session() as sync_session:
            sync_session.add(
                Blob(hash=other_hash, size=28, kind=BlobKind.MESH, format=BlobFormat.STL)
            )
            sync_session.flush()
            row = sync_session.get(File, file_id)
            row.blob_hash = other_hash
            sync_session.commit()
        return result

    monkeypatch.setattr(LocalStorageBackend, "write", write_then_repoint_row)

    store_to_backend(job_id, file_id, path_str)

    job = await jobs_service.get_job_or_404(db_session, uuid.UUID(job_id))
    await db_session.refresh(job)
    assert job.state == "failed"
    assert "superseded" in job.error
    file = await db_session.get(File, file_id)
    await db_session.refresh(file)
    assert file.verified_at is None
    assert file.blob_hash == other_hash  # left untouched by the aborted store


async def test_store_to_backend_mark_running_failure_ends_job_failed(
    db_session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``mark_running`` (state commit + Redis publish) used to run OUTSIDE
    the task's try/except (Task 6 review finding): a transient failure there
    (e.g. the Redis publish) left the job stuck in queued/running forever
    with no retry path -- ``retry_job`` only accepts ``failed`` jobs. Moving
    it inside the try routes the failure through the normal mark_failed
    path instead.
    """
    job_id, file_id, path_str = await _seed_mismatched_job(db_session)

    calls = {"n": 0}
    original_publish = events.publish_job_event_sync

    def flaky_publish(redis_url, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ConnectionError("simulated redis publish failure")
        return original_publish(redis_url, **kwargs)

    monkeypatch.setattr(events, "publish_job_event_sync", flaky_publish)

    with pytest.raises(ConnectionError, match="simulated redis publish failure"):
        store_to_backend(job_id, file_id, path_str)

    job = await jobs_service.get_job_or_404(db_session, uuid.UUID(job_id))
    await db_session.refresh(job)

    assert job.state == "failed"
    assert "simulated redis publish failure" in job.error
    # mark_running's publish raised; mark_failed's own publish (2nd call)
    # went through fine, proving the failure path itself still works.
    assert calls["n"] == 2


async def test_store_to_backend_spool_cleanup_failure_does_not_flip_done_job_to_failed(
    authenticated_client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    data_dir,
) -> None:
    """A spool-cleanup failure AFTER a successful store must not overwrite
    the already-committed ``done`` job/file state back to ``failed`` (Task 6
    review finding) -- cleanup is best-effort disk hygiene, not part of the
    task's correctness contract.
    """

    def flaky_unlink(self, *args, **kwargs):
        raise OSError("simulated spool cleanup failure")

    monkeypatch.setattr(Path, "unlink", flaky_unlink)

    created = await _create_model(authenticated_client, "Cleanup Failure Target")
    revision_id = created["current_revision"]["id"]

    with caplog.at_level(logging.WARNING, logger="app.tasks.ingest"):
        upload = await _upload(
            authenticated_client, model_id=created["id"], revision_id=revision_id
        )

    assert upload.status_code == 201, upload.text
    job_id = upload.json()["job_id"]

    jobs_resp = await authenticated_client.get("/api/jobs")
    job = next(j for j in jobs_resp.json() if j["id"] == job_id)
    assert job["state"] == "done"

    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert any("failed to remove spool file" in r.getMessage() for r in warnings)

    # The unlink failed, so the spool file must still be on disk.
    assert (data_dir / "spool" / job_id).exists()


async def test_list_jobs_filters_by_state(
    authenticated_client: httpx.AsyncClient,
) -> None:
    created = await _create_model(authenticated_client, "Jobs List Target")
    revision_id = created["current_revision"]["id"]
    upload = await _upload(authenticated_client, model_id=created["id"], revision_id=revision_id)
    job_id = upload.json()["job_id"]

    done = await authenticated_client.get("/api/jobs", params={"state": "done"})
    failed = await authenticated_client.get("/api/jobs", params={"state": "failed"})

    assert any(j["id"] == job_id for j in done.json())
    assert not any(j["id"] == job_id for j in failed.json())


async def test_retry_unknown_job_is_404(authenticated_client: httpx.AsyncClient) -> None:
    response = await authenticated_client.post(f"/api/jobs/{uuid.uuid4()}/retry")

    assert response.status_code == 404


async def test_retry_done_job_is_409(authenticated_client: httpx.AsyncClient) -> None:
    created = await _create_model(authenticated_client, "Retry Done Target")
    revision_id = created["current_revision"]["id"]
    upload = await _upload(authenticated_client, model_id=created["id"], revision_id=revision_id)
    job_id = upload.json()["job_id"]

    response = await authenticated_client.post(f"/api/jobs/{job_id}/retry")

    assert response.status_code == 409


async def test_retry_failed_job_without_spool_is_409(
    authenticated_client: httpx.AsyncClient, db_session
) -> None:
    job_id, file_id, path_str = await _seed_mismatched_job(db_session)
    store_to_backend(job_id, file_id, path_str)
    Path(path_str).unlink()

    response = await authenticated_client.post(f"/api/jobs/{job_id}/retry")

    assert response.status_code == 409


async def test_retry_failed_job_with_spool_present_requeues_and_can_succeed(
    authenticated_client: httpx.AsyncClient,
    db_session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A transient backend failure (not a hash mismatch) fails the first
    attempt; retrying with the still-present spool file succeeds on the
    second attempt, preserving (i.e. continuing to increment, not
    resetting) `attempts`.
    """
    calls = {"n": 0}
    original_write = LocalStorageBackend.write

    def flaky_write(self, key, chunks):
        calls["n"] += 1
        if calls["n"] == 1:
            raise OSError("simulated transient failure")
        return original_write(self, key, chunks)

    monkeypatch.setattr(LocalStorageBackend, "write", flaky_write)

    model = Model(slug="retry-flaky", name="Retry Flaky")
    db_session.add(model)
    await db_session.flush()
    revision = Revision(model_id=model.id, number=1, name="initial", dir_name="rev-001_initial")
    db_session.add(revision)
    await db_session.flush()
    model.current_revision_id = revision.id

    content = b"retry-me-bytes"
    digest = blake3.blake3(content).hexdigest()
    blob = Blob(hash=digest, size=len(content), kind=BlobKind.MESH, format=BlobFormat.STL)
    db_session.add(blob)
    await db_session.flush()
    storage_path = f"{model.slug}/{revision.dir_name}/part.stl"
    file = File(
        revision_id=revision.id,
        blob_hash=digest,
        rel_path="part.stl",
        storage_path=storage_path,
        verified_at=None,
    )
    db_session.add(file)
    await db_session.commit()
    await db_session.refresh(file)

    settings = get_settings()
    spool.ensure_spool_dir(settings)
    token = uuid.uuid4()
    path = spool.spool_path(settings, token)
    path.write_bytes(content)

    job = await jobs_service.create_job(
        db_session, id=token, type="store_to_backend", subject_type="file", subject_id=file.id
    )

    with pytest.raises(OSError, match="simulated transient failure"):
        store_to_backend(str(job.id), file.id, str(path))

    await db_session.refresh(job)
    failed_job = await jobs_service.get_job_or_404(db_session, job.id)
    assert failed_job.state == "failed"
    assert path.exists()
    assert failed_job.attempts == 1

    retry_response = await authenticated_client.post(f"/api/jobs/{job.id}/retry")

    assert retry_response.status_code == 200, retry_response.text
    body = retry_response.json()
    assert body["state"] == "done"
    assert body["attempts"] == 2
    assert not path.exists()

    await db_session.refresh(file)
    assert file.verified_at is not None
