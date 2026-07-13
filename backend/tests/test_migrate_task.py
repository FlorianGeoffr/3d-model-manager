"""``migrate_storage`` Celery task (Task 6 brief): copies the whole library
tree from the currently active backend onto a target backend, verifying
blake3 per file as it streams, and only cuts the active ``storage`` setting
over once every file has verified. Exercises the realistic cross-backend
path -- local source -> MinIO/S3 target via the Task 2 testcontainer fixture
-- since ``LocalConfig`` carries no path of its own (always
``LIBRARY_ROOT``), so there's no way to represent a second, distinct
local root as a migration target.
"""

from __future__ import annotations

import logging
import uuid

import pytest

from app.config import get_settings
from app.services import jobs as jobs_service
from app.services.storage_backends import get_default_backend_row
from app.services.storage_config import get_active_config_sync
from app.storage.base import WriteResult
from app.storage.local import LocalStorageBackend
from app.storage.s3 import S3StorageBackend
from app.tasks import base
from app.tasks.migrate import migrate_storage

pytestmark = pytest.mark.usefixtures("library_root", "data_dir")


async def _seed_migrate_job(db_session) -> str:
    token = uuid.uuid4()
    await jobs_service.create_job(
        db_session, id=token, type="migrate_storage", subject_type=None, subject_id=None
    )
    return str(token)


def _plain_target(config) -> dict:
    """``model_dump()`` but with the REAL secret substituted back in.

    M6 A2 (secure-by-default): ``model_dump()`` now always masks the secret
    field to ``"***"``, so it can no longer stand in for a raw dispatch
    payload. Substituting the real value here exercises exactly the same
    "plaintext row" fallback in ``decrypt_config_row`` (``InvalidToken`` ->
    use-as-is) that a genuine pre-M6 legacy row would take -- these tests
    call ``migrate_storage`` directly, bypassing the API's own
    ``encrypt_config_secret`` dispatch wrapping (``app.api.settings``).
    """
    data = config.model_dump()
    data["secret_key"] = config.secret_key.get_secret_value()
    return data


async def test_migrate_copies_verifies_and_cuts_over(
    db_session, backend: LocalStorageBackend, s3_backend
) -> None:
    backend.write("widget/rev-001/part.stl", [b"first-file-bytes"])
    backend.write("widget/rev-001/notes/readme.txt", [b"second-file-bytes"])
    job_id = await _seed_migrate_job(db_session)
    target = _plain_target(s3_backend.config)

    migrate_storage(job_id, target)

    assert b"".join(s3_backend.read("widget/rev-001/part.stl")) == b"first-file-bytes"
    assert b"".join(s3_backend.read("widget/rev-001/notes/readme.txt")) == b"second-file-bytes"

    with base.sync_session() as s:
        active = get_active_config_sync(s, get_settings())
    assert active.backend == "s3"
    assert active.bucket == target["bucket"]
    assert active.secret_key.get_secret_value() == target["secret_key"]

    # M6 A1.5.2 + Workstream C: the target travels encrypted over the broker
    # and the cutover writes it back (encrypted) to the DEFAULT storage_backends
    # row -- the source of truth get_active_config now reads.
    default_row = await get_default_backend_row(db_session)
    assert default_row is not None
    assert default_row.config["secret_key"] != target["secret_key"]

    job = await jobs_service.get_job_or_404(db_session, uuid.UUID(job_id))
    await db_session.refresh(job)
    assert job.state == "done"


async def test_migrate_leaves_source_intact(
    db_session, backend: LocalStorageBackend, s3_backend
) -> None:
    backend.write("widget/rev-001/part.stl", [b"do-not-delete-me"])
    job_id = await _seed_migrate_job(db_session)
    target = _plain_target(s3_backend.config)

    migrate_storage(job_id, target)

    # migrate_storage never deletes/moves anything on the source backend --
    # the file must still be readable from the original local library root.
    assert b"".join(backend.read("widget/rev-001/part.stl")) == b"do-not-delete-me"


async def test_migrate_never_touches_derivatives(
    db_session, backend: LocalStorageBackend, s3_backend, data_dir
) -> None:
    backend.write("widget/rev-001/part.stl", [b"library-bytes"])
    deriv_path = data_dir / "derivatives" / "aa" / "thumb.png"
    deriv_path.parent.mkdir(parents=True, exist_ok=True)
    deriv_path.write_bytes(b"derivative-bytes")

    job_id = await _seed_migrate_job(db_session)
    target = _plain_target(s3_backend.config)

    migrate_storage(job_id, target)

    target_keys = {entry.key for entry in s3_backend.walk("")}
    assert target_keys == {"widget/rev-001/part.stl"}
    # Derivatives live on local disk regardless of the active library
    # backend (Global Constraints "DERIVATIVES ALWAYS STAY LOCAL") -- migrate
    # must not have moved, copied, or deleted this file.
    assert deriv_path.read_bytes() == b"derivative-bytes"


async def test_migrate_hash_mismatch_marks_failed_and_does_not_cut_over(
    db_session,
    backend: LocalStorageBackend,
    s3_backend,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    backend.write("widget/rev-001/part.stl", [b"tampered-in-flight"])
    job_id = await _seed_migrate_job(db_session)
    target = _plain_target(s3_backend.config)

    original_write = S3StorageBackend.write

    def _wrong_hash_write(self, key, chunks):
        result = original_write(self, key, chunks)
        return WriteResult(hash="0" * 64, size=result.size)

    monkeypatch.setattr(S3StorageBackend, "write", _wrong_hash_write)

    with pytest.raises(RuntimeError, match="hash mismatch"):
        migrate_storage(job_id, target)

    job = await jobs_service.get_job_or_404(db_session, uuid.UUID(job_id))
    await db_session.refresh(job)
    assert job.state == "failed"
    assert "hash mismatch" in job.error

    with base.sync_session() as s:
        active = get_active_config_sync(s, get_settings())
    assert active.backend == "local"  # cutover never happened


async def test_migrate_mark_done_failure_after_cutover_does_not_flip_to_failed(
    db_session,
    backend: LocalStorageBackend,
    s3_backend,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """M3-deferred minor, folded into Task 8: a bookkeeping hiccup in
    ``jobs.mark_done`` AFTER the cutover has already committed must NOT
    reflip a genuinely-successful migration to ``failed`` -- the config is
    already switched and the source is intact; there's nothing left to roll
    back, so misreporting it as ``failed`` would be a lie the DB doesn't
    back up (same posture as the ``_publish`` best-effort review finding in
    ``app.services.jobs``).
    """
    backend.write("widget/rev-001/part.stl", [b"already-cut-over-bytes"])
    job_id = await _seed_migrate_job(db_session)
    target = _plain_target(s3_backend.config)

    original_mark_done = jobs_service.mark_done

    def flaky_mark_done(session, jid):
        if jid == job_id:
            raise RuntimeError("simulated post-cutover bookkeeping hiccup")
        return original_mark_done(session, jid)

    monkeypatch.setattr(jobs_service, "mark_done", flaky_mark_done)

    with caplog.at_level(logging.WARNING, logger="app.tasks.migrate"):
        migrate_storage(job_id, target)  # must NOT raise

    # The cutover itself succeeded and must stick despite mark_done blowing
    # up afterward.
    with base.sync_session() as s:
        active = get_active_config_sync(s, get_settings())
    assert active.backend == "s3"

    job = await jobs_service.get_job_or_404(db_session, uuid.UUID(job_id))
    await db_session.refresh(job)
    assert job.state != "failed"

    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert any("cutover succeeded but marking done failed" in r.getMessage() for r in warnings)


async def test_retry_migrate_storage_job_is_409(authenticated_client) -> None:
    response = await authenticated_client.post(
        "/api/settings/storage/migrate", json={"backend": "local", "config": {}}
    )
    job_id = response.json()["id"]
    # The job is `done` (eager mode, no files to migrate) so retry would
    # normally 409 as "not failed" -- force it to `failed` directly to
    # exercise the dedicated `migrate_storage` retry-disposition branch.
    with base.sync_session() as s:
        jobs_service.mark_failed(s, job_id, "forced for test")

    retry_response = await authenticated_client.post(f"/api/jobs/{job_id}/retry")

    assert retry_response.status_code == 409
    assert "Settings" in retry_response.json()["detail"]
