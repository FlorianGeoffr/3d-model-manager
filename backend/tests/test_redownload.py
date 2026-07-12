"""``redownload_model`` Celery task (feat/import-fidelity T3): re-fetches an
EXISTING model's files fresh from its original import source. Mirrors
``tests/test_relocate.py``'s structure -- the task is invoked directly (not
via ``.apply_async``) against a hand-seeded Model/Revision/File chain, with
the same ``fake_import`` fixture (``tests/importer_fixtures.py``)
``tests/test_import_from_url.py`` uses standing in for the real site. The
API surface (job dispatch, 409-no-source, 422-bad-mode) is covered instead
in ``tests/test_models_api.py``.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import blake3
import pytest
from sqlalchemy import select

from app.config import get_settings
from app.importers.fake import FAKE_BASE, FAKE_DL
from app.models import Blob, File, FileLocation, Import, Job, Model, Revision
from app.models.enums import BlobFormat, BlobKind, ImportSite, ImportState
from app.services import jobs as jobs_service
from app.services import storage_backends as sb
from app.tasks.importing import import_from_url, redownload_model
from tests import corpus

pytestmark = pytest.mark.usefixtures("library_root", "data_dir")


async def _seed_source_model(
    db_session,
    backend,
    *,
    external_id: str = "42",
    slug: str = "widget",
    rel_path: str = "part.stl",
    content: bytes = b"old-bytes",
) -> tuple[Model, Revision, File]:
    """Plants a Model whose provenance (``source_site``/``source_url``)
    resolves straight back through ``FakeImporter.canonicalize``, with one
    CURRENT-revision file already fully stored (verified + a
    ``file_locations`` row for the default backend) -- mirrors what a real
    import (``app.tasks.importing.import_from_url``) leaves behind.
    """
    settings = get_settings()
    _default_backend, default_backend_id = await sb.resolve_default_backend(db_session, settings)

    model = Model(
        slug=slug,
        name=slug,
        source_site=ImportSite.THINGIVERSE.value,
        source_url=f"{FAKE_BASE}{external_id}",
    )
    db_session.add(model)
    await db_session.flush()
    revision = Revision(model_id=model.id, number=1, name="imported", dir_name="rev-001_imported")
    db_session.add(revision)
    await db_session.flush()
    model.current_revision_id = revision.id

    digest = blake3.blake3(content).hexdigest()
    blob = Blob(hash=digest, size=len(content), kind=BlobKind.MESH, format=BlobFormat.STL)
    db_session.add(blob)
    await db_session.flush()

    storage_path = f"{model.slug}/{revision.dir_name}/{rel_path}"
    backend.write(storage_path, [content])
    now = datetime.now(UTC)
    file = File(
        revision_id=revision.id,
        blob_hash=digest,
        rel_path=rel_path,
        storage_path=storage_path,
        backend_id=default_backend_id,
        verified_at=now,
    )
    db_session.add(file)
    await db_session.flush()
    db_session.add(FileLocation(file_id=file.id, backend_id=default_backend_id, verified_at=now))
    await db_session.commit()
    await db_session.refresh(model)
    await db_session.refresh(file)
    return model, revision, file


async def _seed_redownload_job(db_session, model_id: int) -> str:
    token = uuid.uuid4()
    await jobs_service.create_job(
        db_session, id=token, type="redownload_model", subject_type="model", subject_id=model_id
    )
    return str(token)


async def _fresh_file_row(db_session, file_id: int) -> File | None:
    """``AsyncSession.get`` can hand back a STALE identity-map hit for a row
    ``redownload_model`` deleted through its own (separate, sync) session --
    a plain ``.get()`` skips the SQL entirely when the PK is already loaded,
    identity-map staleness and all. A fresh ``SELECT`` always hits the DB."""
    return (
        await db_session.execute(select(File).where(File.id == file_id))
    ).scalar_one_or_none()


# ---------------------------------------------------------------------------
# mode="revision"
# ---------------------------------------------------------------------------


async def test_redownload_revision_mode_creates_new_current_revision_leaves_old_intact(
    db_session, backend, fake_import
) -> None:
    fake_import.files = {"cube.stl": corpus.box_stl()}
    model, old_revision, old_file = await _seed_source_model(db_session, backend)
    job_id = await _seed_redownload_job(db_session, model.id)

    redownload_model(job_id, model.id, "revision")

    job = await jobs_service.get_job_or_404(db_session, uuid.UUID(job_id))
    await db_session.refresh(job)
    assert job.state == "done", job.error

    await db_session.refresh(model)
    assert model.current_revision_id != old_revision.id
    new_revision = await db_session.get(Revision, model.current_revision_id)
    assert new_revision.number == 2
    assert new_revision.name == "re-downloaded"

    new_files = (
        (await db_session.execute(select(File).where(File.revision_id == new_revision.id)))
        .scalars()
        .all()
    )
    assert [f.rel_path for f in new_files] == ["cube.stl"]

    # The old revision + its file are left completely untouched.
    await db_session.refresh(old_file)
    assert backend.exists(old_file.storage_path)
    assert b"".join(backend.read(old_file.storage_path)) == b"old-bytes"


async def test_redownload_revision_mode_download_failure_leaves_old_revision_current(
    db_session, backend, fake_import
) -> None:
    fake_import.files = {"ghost.stl": b""}  # empty body -> stream_remote_to_spool raises
    model, old_revision, old_file = await _seed_source_model(db_session, backend)
    job_id = await _seed_redownload_job(db_session, model.id)

    redownload_model(job_id, model.id, "revision")

    job = await jobs_service.get_job_or_404(db_session, uuid.UUID(job_id))
    await db_session.refresh(job)
    assert job.state == "failed"
    assert job.error

    await db_session.refresh(model)
    assert model.current_revision_id == old_revision.id
    assert backend.exists(old_file.storage_path)


# ---------------------------------------------------------------------------
# mode="replace"
# ---------------------------------------------------------------------------


async def test_redownload_replace_mode_keeps_revision_id_swaps_files(
    db_session, backend, fake_import
) -> None:
    fake_import.files = {"cube.stl": corpus.box_stl()}
    model, revision, old_file = await _seed_source_model(db_session, backend)
    old_storage_path = old_file.storage_path
    old_file_id = old_file.id
    job_id = await _seed_redownload_job(db_session, model.id)

    redownload_model(job_id, model.id, "replace")

    job = await jobs_service.get_job_or_404(db_session, uuid.UUID(job_id))
    await db_session.refresh(job)
    assert job.state == "done", job.error

    await db_session.refresh(model)
    assert model.current_revision_id == revision.id  # same revision, not a new one

    assert not backend.exists(old_storage_path)
    assert await _fresh_file_row(db_session, old_file_id) is None

    current_files = (
        (await db_session.execute(select(File).where(File.revision_id == revision.id)))
        .scalars()
        .all()
    )
    assert [f.rel_path for f in current_files] == ["cube.stl"]
    assert backend.exists(f"{model.slug}/{revision.dir_name}/cube.stl")


async def test_redownload_replace_mode_refreshes_images_and_cover(
    db_session, backend, fake_import
) -> None:
    fake_import.files = {"cube.stl": corpus.box_stl()}
    fake_import.image_bytes = {"cover.png": corpus.red_png()}
    fake_import.image_urls = (f"{FAKE_DL}cover.png",)
    model, revision, _old_file = await _seed_source_model(db_session, backend)
    job_id = await _seed_redownload_job(db_session, model.id)

    redownload_model(job_id, model.id, "replace")

    job = await jobs_service.get_job_or_404(db_session, uuid.UUID(job_id))
    await db_session.refresh(job)
    assert job.state == "done", job.error

    await db_session.refresh(model)
    current_files = (
        (await db_session.execute(select(File).where(File.revision_id == revision.id)))
        .scalars()
        .all()
    )
    rel_paths = sorted(f.rel_path for f in current_files)
    assert rel_paths == ["cube.stl", "images/01-cover.png"]

    cover_file = next(f for f in current_files if f.rel_path == "images/01-cover.png")
    assert model.cover_blob_hash == cover_file.blob_hash


async def test_redownload_replace_mode_pending_job_fails_cleanly_leaves_old_files(
    db_session, backend, fake_import
) -> None:
    """Everything downloads fine (spool-first), but the apply phase's
    pending-job guard rejects BEFORE anything on the current revision is
    touched -- the old file must still be exactly as it was.
    """
    fake_import.files = {"cube.stl": corpus.box_stl()}
    model, _revision, old_file = await _seed_source_model(db_session, backend)
    old_file.verified_at = None
    db_session.add(
        Job(
            id=uuid.uuid4(),
            type="store_to_backend",
            subject_type="file",
            subject_id=old_file.id,
            state=jobs_service.STATE_QUEUED,
        )
    )
    await db_session.commit()
    job_id = await _seed_redownload_job(db_session, model.id)

    redownload_model(job_id, model.id, "replace")

    job = await jobs_service.get_job_or_404(db_session, uuid.UUID(job_id))
    await db_session.refresh(job)
    assert job.state == "failed"
    assert job.error

    assert backend.exists(old_file.storage_path)
    assert await _fresh_file_row(db_session, old_file.id) is not None


async def test_redownload_replace_mode_download_failure_leaves_old_files_intact(
    db_session, backend, fake_import
) -> None:
    """Spool-first ordering (T3 brief): a download failure must never touch
    the current revision's existing files."""
    fake_import.files = {"ghost.stl": b""}  # empty body -> stream_remote_to_spool raises
    model, _revision, old_file = await _seed_source_model(db_session, backend)
    job_id = await _seed_redownload_job(db_session, model.id)

    redownload_model(job_id, model.id, "replace")

    job = await jobs_service.get_job_or_404(db_session, uuid.UUID(job_id))
    await db_session.refresh(job)
    assert job.state == "failed"

    assert backend.exists(old_file.storage_path)
    assert await _fresh_file_row(db_session, old_file.id) is not None


# ---------------------------------------------------------------------------
# API-level dispatch (mechanics-adjacent: needs a real fake-imported model,
# so it lives here rather than tests/test_models_api.py's pure-surface tests)
# ---------------------------------------------------------------------------


async def test_redownload_dispatches_tracked_job_via_api(
    authenticated_client, db_session, backend, fake_import
) -> None:
    fake_import.files = {"cube.stl": corpus.box_stl()}
    imp = Import(
        url=f"{FAKE_BASE}42",
        site=ImportSite.THINGIVERSE,
        external_id="42",
        state=ImportState.PENDING,
    )
    db_session.add(imp)
    await db_session.commit()
    await db_session.refresh(imp)

    import_from_url(imp.id)  # eager, sync -- produces a real imported model

    await db_session.refresh(imp)
    assert imp.state == ImportState.DONE
    model = await db_session.get(Model, imp.model_id)

    fake_import.files = {"cube-v2.stl": corpus.box_stl()}  # a "changed upstream" for the redownload

    response = await authenticated_client.post(
        f"/api/models/{model.slug}/redownload", json={"mode": "revision"}
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["type"] == "redownload_model"
    assert body["id"]
    assert body["state"] in {"queued", "running", "done", "failed"}
