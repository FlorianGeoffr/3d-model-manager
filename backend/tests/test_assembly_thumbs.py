"""``render_assembly_thumb`` + the assembly-trigger wiring (Task 6; SPEC
pipeline row 6; Global Constraints "Pipeline jobs" render_assembly_thumb
exception): a per-REVISION render (not a ``@pipeline_step`` -- own Celery
task, own manual job transitions, mirroring
``app.tasks.ingest.store_to_backend``'s pattern) triggered whenever a
revision's mesh/cad content becomes fully converted, via
``pipeline.maybe_enqueue_assembly_sync`` (worker-side, replacing Task 2's
no-op ``pipeline_completed_hook``) and its async twin
``pipeline.maybe_enqueue_assembly_async`` (API-side, called from
``services.library.create_revision``/``delete_file``).
"""

from __future__ import annotations

import httpx
import pytest
import trimesh
from PIL import Image
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models import AssemblyThumb, Job, Model, Revision
from app.models.enums import BlobFormat, BlobKind, DerivativeKind, DerivativeStatus
from app.services import derivatives
from app.tasks import pipeline
from app.tasks.base import sync_session
from tests.corpus import CorpusPaths

pytestmark = pytest.mark.usefixtures("library_root", "data_dir")

_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _distinct_byte_values(png_path) -> int:
    with Image.open(png_path) as image:
        return len(set(image.tobytes()))


async def _seed_model_and_revision(db_session: AsyncSession) -> tuple[Model, Revision]:
    model = Model(slug="widget", name="Widget")
    db_session.add(model)
    await db_session.flush()
    revision = Revision(model_id=model.id, number=1, dir_name="rev-001")
    db_session.add(revision)
    await db_session.flush()
    return model, revision


def _write_ok_glb_derivative_sync(
    blob_hash: str, *, extents: tuple[float, float, float] = (20.0, 10.0, 5.0)
) -> None:
    """Real, ``ok`` ``glb`` derivative for ``blob_hash`` -- a box exported
    straight from trimesh, exactly what ``convert_to_glb`` would have
    produced (that step's own conversion tests cover it separately).
    """
    settings = get_settings()
    glb_path = derivatives.derivative_path(settings, blob_hash, DerivativeKind.GLB)
    glb_path.parent.mkdir(parents=True, exist_ok=True)
    box = trimesh.creation.box(extents=extents)
    glb_path.write_bytes(box.export(file_type="glb"))
    with sync_session() as session:
        deriv = derivatives.upsert_derivative(session, blob_hash, DerivativeKind.GLB)
        derivatives.mark_derivative(
            session, deriv, status=DerivativeStatus.OK, local_path=str(glb_path), tool="trimesh"
        )


async def _seed_job(db_session: AsyncSession, *, revision_id: int, state: str = "queued") -> Job:
    job = Job(
        type="render_assembly_thumb", subject_type="revision", subject_id=revision_id, state=state
    )
    db_session.add(job)
    await db_session.commit()
    await db_session.refresh(job)
    return job


# ---------------------------------------------------------------------------
# render_assembly_thumb task, called directly (Task 3-5 convention).
# ---------------------------------------------------------------------------


async def test_render_assembly_thumb_merges_two_mesh_files_into_ok_thumbnail(
    db_session: AsyncSession, seed_file, corpus: CorpusPaths
) -> None:
    settings = get_settings()
    model, revision = await _seed_model_and_revision(db_session)
    file_a = await seed_file(
        model,
        revision,
        "a.stl",
        corpus.box_stl.read_bytes(),
        blob_format=BlobFormat.STL,
        blob_kind=BlobKind.MESH,
    )
    file_b = await seed_file(
        model,
        revision,
        "b.obj",
        corpus.box_obj.read_bytes(),
        blob_format=BlobFormat.OBJ,
        blob_kind=BlobKind.MESH,
    )
    _write_ok_glb_derivative_sync(file_a.blob_hash, extents=(20.0, 10.0, 5.0))
    _write_ok_glb_derivative_sync(file_b.blob_hash, extents=(8.0, 8.0, 8.0))

    revision_id = revision.id
    job = await _seed_job(db_session, revision_id=revision_id)
    job_id = job.id

    pipeline.render_assembly_thumb(str(job_id), revision_id)

    out_path = derivatives.assembly_thumb_path(settings, revision_id)
    assert out_path.read_bytes()[:8] == _PNG_MAGIC
    with Image.open(out_path) as image:
        assert image.size == (1024, 1024)
    assert _distinct_byte_values(out_path) > 1

    db_session.expire_all()
    job = await db_session.get(Job, job_id)
    assert job.state == "done"

    thumb = await db_session.get(AssemblyThumb, revision_id)
    assert thumb.status == DerivativeStatus.OK
    assert thumb.local_path == str(out_path)
    assert thumb.error is None


async def test_render_assembly_thumb_zero_mesh_files_is_unsupported(
    db_session: AsyncSession, seed_file, corpus: CorpusPaths
) -> None:
    settings = get_settings()
    model, revision = await _seed_model_and_revision(db_session)
    await seed_file(
        model,
        revision,
        "plate_1.gcode",
        corpus.bambu_gcode.read_bytes(),
        blob_format=BlobFormat.GCODE,
        blob_kind=BlobKind.GCODE,
    )

    revision_id = revision.id
    job = await _seed_job(db_session, revision_id=revision_id)
    job_id = job.id

    pipeline.render_assembly_thumb(str(job_id), revision_id)

    out_path = derivatives.assembly_thumb_path(settings, revision_id)
    assert not out_path.exists()

    db_session.expire_all()
    job = await db_session.get(Job, job_id)
    assert job.state == "done"

    thumb = await db_session.get(AssemblyThumb, revision_id)
    assert thumb.status == DerivativeStatus.UNSUPPORTED


async def test_render_assembly_thumb_render_failure_marks_job_and_thumb_failed(
    db_session: AsyncSession, seed_file, corpus: CorpusPaths, monkeypatch: pytest.MonkeyPatch
) -> None:
    model, revision = await _seed_model_and_revision(db_session)
    file_a = await seed_file(
        model,
        revision,
        "a.stl",
        corpus.box_stl.read_bytes(),
        blob_format=BlobFormat.STL,
        blob_kind=BlobKind.MESH,
    )
    _write_ok_glb_derivative_sync(file_a.blob_hash)

    def _boom(*args, **kwargs):
        raise RuntimeError("simulated render failure")

    monkeypatch.setattr(pipeline.render, "render_glb_png", _boom)

    revision_id = revision.id
    job = await _seed_job(db_session, revision_id=revision_id)
    job_id = job.id

    with pytest.raises(RuntimeError, match="simulated render failure"):
        pipeline.render_assembly_thumb(str(job_id), revision_id)

    db_session.expire_all()
    job = await db_session.get(Job, job_id)
    assert job.state == "failed"
    assert "simulated render failure" in job.error

    thumb = await db_session.get(AssemblyThumb, revision_id)
    assert thumb.status == DerivativeStatus.FAILED
    assert "simulated render failure" in thumb.error


# ---------------------------------------------------------------------------
# maybe_enqueue_assembly_sync: the worker-side trigger (replaces Task 2's
# no-op pipeline_completed_hook).
# ---------------------------------------------------------------------------


async def test_maybe_enqueue_assembly_sync_enqueues_once_after_both_mesh_blobs_ready(
    db_session: AsyncSession, seed_file, corpus: CorpusPaths
) -> None:
    model, revision = await _seed_model_and_revision(db_session)
    file_a = await seed_file(
        model,
        revision,
        "a.stl",
        corpus.box_stl.read_bytes(),
        blob_format=BlobFormat.STL,
        blob_kind=BlobKind.MESH,
    )
    file_b = await seed_file(
        model,
        revision,
        "b.obj",
        corpus.box_obj.read_bytes(),
        blob_format=BlobFormat.OBJ,
        blob_kind=BlobKind.MESH,
    )

    # Only blob A is converted so far -- not ready (blob B has no glb at all).
    _write_ok_glb_derivative_sync(file_a.blob_hash)
    with sync_session() as session:
        pipeline.maybe_enqueue_assembly_sync(session, blob_hash=file_a.blob_hash)

    jobs_after_a = (
        (
            await db_session.execute(
                select(Job).where(
                    Job.type == "render_assembly_thumb", Job.subject_id == revision.id
                )
            )
        )
        .scalars()
        .all()
    )
    assert jobs_after_a == []

    # Now blob B finishes too -- the revision becomes ready, exactly once.
    _write_ok_glb_derivative_sync(file_b.blob_hash, extents=(8.0, 8.0, 8.0))
    with sync_session() as session:
        pipeline.maybe_enqueue_assembly_sync(session, blob_hash=file_b.blob_hash)

    jobs_after_b = (
        (
            await db_session.execute(
                select(Job).where(
                    Job.type == "render_assembly_thumb", Job.subject_id == revision.id
                )
            )
        )
        .scalars()
        .all()
    )
    assert len(jobs_after_b) == 1
    assert jobs_after_b[0].subject_type == "revision"


async def test_maybe_enqueue_assembly_sync_skips_when_job_already_in_flight(
    db_session: AsyncSession, seed_file, corpus: CorpusPaths
) -> None:
    model, revision = await _seed_model_and_revision(db_session)
    file_a = await seed_file(
        model,
        revision,
        "a.stl",
        corpus.box_stl.read_bytes(),
        blob_format=BlobFormat.STL,
        blob_kind=BlobKind.MESH,
    )
    _write_ok_glb_derivative_sync(file_a.blob_hash)

    in_flight = await _seed_job(db_session, revision_id=revision.id, state="running")

    with sync_session() as session:
        pipeline.maybe_enqueue_assembly_sync(session, blob_hash=file_a.blob_hash)

    jobs = (
        (
            await db_session.execute(
                select(Job).where(
                    Job.type == "render_assembly_thumb", Job.subject_id == revision.id
                )
            )
        )
        .scalars()
        .all()
    )
    assert [j.id for j in jobs] == [in_flight.id]


async def test_gcode_only_upload_triggers_unsupported_assembly_via_pipeline_completion(
    authenticated_client: httpx.AsyncClient, corpus: CorpusPaths
) -> None:
    """End-to-end proof that the trigger fires off a REAL pipeline
    completion, not just direct calls: a gcode blob's pipeline is just
    ``extract_metadata`` (Global Constraints "Pipeline shape"), and finishing
    it still calls ``maybe_enqueue_assembly_sync`` -- ready vacuously (no
    mesh/cad blobs at all) -- so the assembly job runs and lands on
    ``unsupported``.
    """
    response = await authenticated_client.post("/api/models", json={"name": "Gcode Only Assembly"})
    assert response.status_code == 201, response.text
    body = response.json()
    revision_id = body["current_revision"]["id"]

    upload = await authenticated_client.put(
        "/api/uploads",
        params={"model_id": body["id"], "revision_id": revision_id, "rel_path": "plate_1.gcode"},
        content=corpus.bambu_gcode.read_bytes(),
    )
    assert upload.status_code == 201, upload.text

    jobs_resp = await authenticated_client.get("/api/jobs")
    assembly_jobs = [j for j in jobs_resp.json() if j["type"] == "render_assembly_thumb"]
    assert len(assembly_jobs) == 1
    assert assembly_jobs[0]["state"] == "done"
    assert assembly_jobs[0]["subject_type"] == "revision"
    assert assembly_jobs[0]["subject_id"] == revision_id


# ---------------------------------------------------------------------------
# API-side triggers: create_revision / delete_file (services.library).
# ---------------------------------------------------------------------------


async def test_create_revision_triggers_assembly_when_ready(
    authenticated_client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_file,
    corpus: CorpusPaths,
) -> None:
    created_resp = await authenticated_client.post(
        "/api/models", json={"name": "Create Revision Assembly Trigger"}
    )
    assert created_resp.status_code == 201, created_resp.text
    created = created_resp.json()
    model = await db_session.get(Model, created["id"])
    rev1 = await db_session.get(Revision, model.current_revision_id)

    file_a = await seed_file(
        model,
        rev1,
        "part.stl",
        corpus.box_stl.read_bytes(),
        blob_format=BlobFormat.STL,
        blob_kind=BlobKind.MESH,
    )
    _write_ok_glb_derivative_sync(file_a.blob_hash)

    response = await authenticated_client.post(f"/api/models/{created['id']}/revisions", json={})
    assert response.status_code == 201, response.text
    rev2_id = response.json()["id"]

    jobs_resp = await authenticated_client.get("/api/jobs")
    assembly_jobs = [
        j
        for j in jobs_resp.json()
        if j["type"] == "render_assembly_thumb" and j["subject_id"] == rev2_id
    ]
    assert len(assembly_jobs) == 1


async def test_delete_file_triggers_assembly_for_remaining_composition(
    authenticated_client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_file,
    corpus: CorpusPaths,
) -> None:
    created_resp = await authenticated_client.post(
        "/api/models", json={"name": "Delete File Assembly Trigger"}
    )
    assert created_resp.status_code == 201, created_resp.text
    created = created_resp.json()
    model = await db_session.get(Model, created["id"])
    rev1 = await db_session.get(Revision, model.current_revision_id)

    file_a = await seed_file(
        model,
        rev1,
        "a.stl",
        corpus.box_stl.read_bytes(),
        blob_format=BlobFormat.STL,
        blob_kind=BlobKind.MESH,
    )
    await seed_file(
        model,
        rev1,
        "b.gcode",
        corpus.bambu_gcode.read_bytes(),
        blob_format=BlobFormat.GCODE,
        blob_kind=BlobKind.GCODE,
    )
    _write_ok_glb_derivative_sync(file_a.blob_hash)

    # Deleting the only mesh file leaves an all-gcode revision -- vacuously
    # "ready" (no mesh/cad blobs left to wait on) -- still a valid trigger.
    response = await authenticated_client.delete(f"/api/files/{file_a.id}")
    assert response.status_code == 204, response.text

    jobs_resp = await authenticated_client.get("/api/jobs")
    assembly_jobs = [
        j
        for j in jobs_resp.json()
        if j["type"] == "render_assembly_thumb" and j["subject_id"] == rev1.id
    ]
    assert len(assembly_jobs) == 1


# ---------------------------------------------------------------------------
# jobs.retry_job's render_assembly_thumb branch.
# ---------------------------------------------------------------------------


async def test_retry_render_assembly_thumb_redispatches_and_succeeds(
    authenticated_client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_file,
    corpus: CorpusPaths,
) -> None:
    model, revision = await _seed_model_and_revision(db_session)
    file_a = await seed_file(
        model,
        revision,
        "a.stl",
        corpus.box_stl.read_bytes(),
        blob_format=BlobFormat.STL,
        blob_kind=BlobKind.MESH,
    )
    _write_ok_glb_derivative_sync(file_a.blob_hash)

    job = await _seed_job(db_session, revision_id=revision.id, state="failed")
    job.error = "boom"
    await db_session.commit()

    response = await authenticated_client.post(f"/api/jobs/{job.id}/retry")

    assert response.status_code == 200, response.text
    assert response.json()["state"] == "done"


async def test_retry_render_assembly_thumb_subject_revision_gone_is_409(
    authenticated_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    job = await _seed_job(db_session, revision_id=999999, state="failed")
    job.error = "boom"
    await db_session.commit()

    response = await authenticated_client.post(f"/api/jobs/{job.id}/retry")

    assert response.status_code == 409
    assert "subject revision no longer exists" in response.json()["detail"]
