"""Regression coverage for ``library.store_imported_file_sync``'s blob
get-or-create/upsert (feat/import-fidelity bugfix, live-verified against
``micro-sd-card-rugged-box``): a MakerWorld print-profile ``.zip`` download
is actually a 3MF container, but ``layout.infer_blob_kind_format`` doesn't
recognize ``.zip`` at all, so its FIRST import lands as
``kind=other, format=other`` -- ``PIPELINE_STEPS[OTHER]`` is empty, so no
glb/thumb derivative is ever produced. Re-downloading (or re-importing) the
SAME bytes later, this time named ``.3mf``, must upgrade that stale blob row
IN PLACE, since ``start_pipeline_sync`` reads the blob row's format, not the
newly-staged one -- otherwise every File that ever shares that hash (past
AND future) stays permanently stuck on ``other``.

Uses a test-only ``@pipeline_step`` (module scope, same pattern as
``tests/test_pipeline_driver.py``) instead of the real steps so the dispatch
assertions don't depend on ``trimesh``/``gltfpack`` actually succeeding
against placeholder byte content.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest
from blake3 import blake3
from sqlalchemy import select

from app.config import get_settings
from app.importers.download import StagedFile
from app.models import Blob, Job, Model, Revision
from app.models.enums import BlobFormat, BlobKind
from app.services import layout, library, spool
from app.services.storage_config import resolve_backend_sync
from app.tasks import base, pipeline
from app.tasks.pipeline import pipeline_step, run_step

pytestmark = pytest.mark.usefixtures("library_root", "data_dir")

_STEP_NAME = "blob_typing_upgrade_test_step"
_calls: list[str] = []


def _fake_step_fn(session, settings, backend, blob):
    _calls.append(blob.hash)
    return "done"


@pipeline_step(_STEP_NAME)
def _fake_step_task(job_id: str, blob_hash: str) -> None:
    run_step(job_id, blob_hash, _STEP_NAME, _fake_step_fn)


@pytest.fixture(autouse=True)
def _reset_calls():
    _calls.clear()
    yield
    _calls.clear()


def _seed_model(session) -> tuple[Model, Revision]:
    backend = resolve_backend_sync(session, get_settings())
    model = library.create_imported_model_sync(
        session,
        backend,
        name=f"Blob Typing Target {uuid.uuid4().hex[:8]}",
        description=None,
        source_url="https://fake.test/thing/1",
        source_site="thingiverse",
        source_author=None,
        source_license=None,
        imported_at=datetime.now(UTC),
        tags=[],
    )
    revision = session.get(Revision, model.current_revision_id)
    return model, revision


def _stage(settings, rel_path: str, content: bytes) -> StagedFile:
    """Test-only twin of ``download.stream_remote_to_spool``: writes
    ``content`` straight to a real spool file (mirrors
    ``tests/test_import_archives.py``'s ``_stage_bytes``) and infers
    ``kind``/``format_`` from ``rel_path`` exactly like the real import flow.
    """
    spool.ensure_spool_dir(settings)
    token = uuid.uuid4()
    path = spool.spool_path(settings, token)
    path.write_bytes(content)
    kind, format_ = layout.infer_blob_kind_format(rel_path)
    return StagedFile(
        token=token,
        spool_path=path,
        blob_hash=blake3(content).hexdigest(),
        size=len(content),
        rel_path=rel_path,
        kind=kind,
        format_=format_,
    )


def _job_for(session, *, subject_id: int, job_type: str) -> Job | None:
    return session.execute(
        select(Job).where(Job.subject_id == subject_id, Job.type == job_type)
    ).scalar_one_or_none()


# ---------------------------------------------------------------------------
# The bug: a stale `other`/`other` blob gets upgraded once the SAME bytes
# arrive again under a real extension, and the pipeline actually dispatches.
# ---------------------------------------------------------------------------


def test_reimport_same_bytes_as_3mf_upgrades_stale_other_blob_and_dispatches_pipeline(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(pipeline, "PIPELINE_STEPS", {BlobFormat.THREEMF: (_STEP_NAME,)})
    settings = get_settings()
    # Real content doesn't matter here -- the fake step never reads bytes --
    # only that the SAME bytes are staged twice, under two different names.
    content = b"maker-world-profile-bytes-that-are-really-a-3mf-container"

    with base.sync_session() as session:
        model, revision = _seed_model(session)

        zip_staged = _stage(settings, "profile.zip", content)
        assert (zip_staged.kind, zip_staged.format_) == (BlobKind.OTHER, BlobFormat.OTHER)

        zip_file = library.store_imported_file_sync(
            session, model=model, revision=revision, staged=zip_staged
        )

        blob = session.get(Blob, zip_staged.blob_hash)
        assert (blob.kind, blob.format) == (BlobKind.OTHER, BlobFormat.OTHER)
        # PIPELINE_STEPS[OTHER] is empty -- nothing was ever dispatched for
        # this file, matching the live bug (zero derivative rows).
        assert _job_for(session, subject_id=zip_file.id, job_type=_STEP_NAME) is None

        threemf_staged = _stage(settings, "profile.3mf", content)
        assert threemf_staged.blob_hash == zip_staged.blob_hash  # identical bytes
        assert (threemf_staged.kind, threemf_staged.format_) == (BlobKind.MESH, BlobFormat.THREEMF)

        threemf_file = library.store_imported_file_sync(
            session, model=model, revision=revision, staged=threemf_staged
        )

        # The EXISTING blob row (shared by both files, same hash) is upgraded
        # in place -- `blob` is the same identity-mapped ORM instance.
        assert (blob.kind, blob.format) == (BlobKind.MESH, BlobFormat.THREEMF)

        step_job = _job_for(session, subject_id=threemf_file.id, job_type=_STEP_NAME)
        assert step_job is not None
        assert step_job.state == "done"
        assert _calls == [threemf_staged.blob_hash]


# ---------------------------------------------------------------------------
# Never downgrade: a specific format stays specific even if the SAME bytes
# later show up under an unrecognized name.
# ---------------------------------------------------------------------------


def test_specific_format_blob_restored_under_unrecognized_name_stays_specific(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(pipeline, "PIPELINE_STEPS", {})  # dispatch isn't the point here
    settings = get_settings()
    content = b"bytes-first-seen-as-a-real-stl"

    with base.sync_session() as session:
        model, revision = _seed_model(session)

        stl_staged = _stage(settings, "part.stl", content)
        assert (stl_staged.kind, stl_staged.format_) == (BlobKind.MESH, BlobFormat.STL)
        library.store_imported_file_sync(session, model=model, revision=revision, staged=stl_staged)

        blob = session.get(Blob, stl_staged.blob_hash)
        assert blob.format == BlobFormat.STL

        zip_staged = _stage(settings, "part.zip", content)  # SAME bytes, unrecognized name
        assert zip_staged.blob_hash == stl_staged.blob_hash
        assert (zip_staged.kind, zip_staged.format_) == (BlobKind.OTHER, BlobFormat.OTHER)
        library.store_imported_file_sync(session, model=model, revision=revision, staged=zip_staged)

        assert (blob.kind, blob.format) == (BlobKind.MESH, BlobFormat.STL)  # never downgraded


# ---------------------------------------------------------------------------
# Never cross-overwrite: two DIFFERENT specific formats for the same hash
# leave the stored row exactly as it was.
# ---------------------------------------------------------------------------


def test_specific_format_blob_restored_under_different_specific_name_is_untouched(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(pipeline, "PIPELINE_STEPS", {})  # dispatch isn't the point here
    settings = get_settings()
    content = b"bytes-two-importers-would-disagree-about"

    with base.sync_session() as session:
        model, revision = _seed_model(session)

        stl_staged = _stage(settings, "part.stl", content)
        library.store_imported_file_sync(session, model=model, revision=revision, staged=stl_staged)
        blob = session.get(Blob, stl_staged.blob_hash)
        assert blob.format == BlobFormat.STL

        threemf_staged = _stage(
            settings, "part.3mf", content
        )  # SAME bytes, a DIFFERENT specific format
        assert threemf_staged.blob_hash == stl_staged.blob_hash
        assert threemf_staged.format_ == BlobFormat.THREEMF
        library.store_imported_file_sync(
            session, model=model, revision=revision, staged=threemf_staged
        )

        assert (blob.kind, blob.format) == (BlobKind.MESH, BlobFormat.STL)  # untouched
