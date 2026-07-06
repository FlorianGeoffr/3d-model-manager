"""``optimize_glb`` pipeline step tests (Task 5; SPEC pipeline row 4;
RESEARCH §5): gltfpack ``-cc`` meshopt compression of the raw ``glb``
derivative into the rowless, browser-only ``glb_web`` file, plus the
``-si 0.5`` decimated LOD (``glb_preview`` derivative row) above the
triangle-count threshold.

Global Constraints "Two GLB artifacts per blob" is the thing that matters
most here: the raw ``glb`` derivative must come out of this step
byte-for-byte unchanged (gltfpack's meshopt output can't be read back by
f3d/trimesh/OCCT), and trimesh must still be able to load it after the step
runs. The compressed outputs (``glb_web``/``glb_preview``) can't be
`trimesh.load`ed at all once meshopt-compressed (verified directly against
real gltfpack output) -- so this module only checks their glTF magic bytes
and size, not a mesh round-trip.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import trimesh
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models import Blob, BlobMeta, Derivative, Job, Model, Revision
from app.models.enums import BlobFormat, BlobKind, DerivativeKind, DerivativeStatus
from app.services import derivatives
from app.storage.local import LocalStorageBackend
from app.tasks import pipeline
from app.tasks.base import sync_session
from tests.corpus import CorpusPaths

pytestmark = pytest.mark.usefixtures("library_root", "data_dir")

_GLB_MAGIC = b"glTF"


async def _seed_model_and_revision(db_session: AsyncSession) -> tuple[Model, Revision]:
    model = Model(slug="widget", name="Widget")
    db_session.add(model)
    await db_session.flush()
    revision = Revision(model_id=model.id, number=1, dir_name="rev-001")
    db_session.add(revision)
    await db_session.flush()
    return model, revision


async def _seed_blob_with_ok_glb(
    db_session: AsyncSession,
    seed_file,
    corpus: CorpusPaths,
    *,
    rel_path: str = "part.stl",
) -> str:
    """Seed a file/blob and a real, ``ok`` ``glb`` derivative for it -- the
    box exported straight from trimesh, exactly what ``convert_to_glb`` would
    have produced (Task 5's own conversion tests cover that step separately).
    """
    settings = get_settings()
    content = corpus.box_stl.read_bytes()
    model, revision = await _seed_model_and_revision(db_session)
    file = await seed_file(
        model, revision, rel_path, content, blob_format=BlobFormat.STL, blob_kind=BlobKind.MESH
    )

    glb_path = derivatives.derivative_path(settings, file.blob_hash, DerivativeKind.GLB)
    glb_path.parent.mkdir(parents=True, exist_ok=True)
    box = trimesh.creation.box(extents=(20.0, 10.0, 5.0))
    glb_path.write_bytes(box.export(file_type="glb"))

    db_session.add(
        Derivative(
            blob_hash=file.blob_hash,
            kind=DerivativeKind.GLB,
            status=DerivativeStatus.OK,
            local_path=str(glb_path),
            tool="trimesh",
        )
    )
    await db_session.commit()
    return file.blob_hash


# ---------------------------------------------------------------------------
# The registered pipeline step, called directly (Task 3/4 convention).
# ---------------------------------------------------------------------------


async def test_optimize_glb_publishes_glb_web_and_never_touches_raw_glb(
    db_session: AsyncSession,
    backend: LocalStorageBackend,
    seed_file,
    corpus: CorpusPaths,
) -> None:
    settings = get_settings()
    blob_hash = await _seed_blob_with_ok_glb(db_session, seed_file, corpus)
    raw_glb_path = derivatives.derivative_path(settings, blob_hash, DerivativeKind.GLB)
    raw_bytes_before = raw_glb_path.read_bytes()

    with sync_session() as session:
        blob = session.get(Blob, blob_hash)
        outcome = pipeline._optimize_glb_step(session, settings, backend, blob)

    assert outcome == "done"

    web_path = derivatives.glb_web_path(settings, blob_hash)
    assert web_path.exists()
    assert web_path.read_bytes()[:4] == _GLB_MAGIC

    # The regression that matters: the raw glb derivative is bit-for-bit
    # untouched, and still loadable by trimesh (unlike the meshopt-compressed
    # glb_web file next to it).
    assert raw_glb_path.read_bytes() == raw_bytes_before
    mesh = trimesh.load(raw_glb_path)
    if isinstance(mesh, trimesh.Scene):
        mesh = mesh.to_geometry()
    assert len(mesh.faces) == 12

    # No triangle_count in blob_meta at all -> no preview LOD generated.
    with sync_session() as session:
        preview_count = session.scalar(
            select(func.count())
            .select_from(Derivative)
            .where(Derivative.blob_hash == blob_hash, Derivative.kind == DerivativeKind.GLB_PREVIEW)
        )
    assert preview_count == 0


async def test_optimize_glb_reruns_skip_once_glb_web_exists(
    db_session: AsyncSession,
    backend: LocalStorageBackend,
    seed_file,
    corpus: CorpusPaths,
) -> None:
    settings = get_settings()
    blob_hash = await _seed_blob_with_ok_glb(db_session, seed_file, corpus)

    with sync_session() as session:
        blob = session.get(Blob, blob_hash)
        first = pipeline._optimize_glb_step(session, settings, backend, blob)
    assert first == "done"

    web_path = derivatives.glb_web_path(settings, blob_hash)
    written_at = web_path.read_bytes()

    with sync_session() as session:
        blob = session.get(Blob, blob_hash)
        second = pipeline._optimize_glb_step(session, settings, backend, blob)

    assert second == "skipped"
    assert web_path.read_bytes() == written_at


async def test_optimize_glb_missing_glb_derivative_raises(
    db_session: AsyncSession,
    backend: LocalStorageBackend,
    seed_file,
    corpus: CorpusPaths,
) -> None:
    settings = get_settings()
    content = corpus.box_stl.read_bytes()
    model, revision = await _seed_model_and_revision(db_session)
    file = await seed_file(
        model, revision, "part.stl", content, blob_format=BlobFormat.STL, blob_kind=BlobKind.MESH
    )

    with sync_session() as session:
        blob = session.get(Blob, file.blob_hash)
        with pytest.raises(RuntimeError, match="glb missing"):
            pipeline._optimize_glb_step(session, settings, backend, blob)


async def test_optimize_glb_preview_lod_generated_above_threshold(
    db_session: AsyncSession,
    backend: LocalStorageBackend,
    seed_file,
    corpus: CorpusPaths,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Generating a real >1.5M-triangle mesh in a unit test would waste
    minutes of CPU (brief's own allowed edge) -- monkeypatch the threshold
    down to 10 instead, well below the box's real 12 triangles.
    """
    monkeypatch.setattr(pipeline, "PREVIEW_TRIANGLE_THRESHOLD", 10)
    settings = get_settings()
    blob_hash = await _seed_blob_with_ok_glb(db_session, seed_file, corpus)
    db_session.add(BlobMeta(blob_hash=blob_hash, triangle_count=12))
    await db_session.commit()

    with sync_session() as session:
        blob = session.get(Blob, blob_hash)
        outcome = pipeline._optimize_glb_step(session, settings, backend, blob)

    assert outcome == "done"

    with sync_session() as session:
        preview_deriv = session.execute(
            select(Derivative).where(
                Derivative.blob_hash == blob_hash, Derivative.kind == DerivativeKind.GLB_PREVIEW
            )
        ).scalar_one()
    assert preview_deriv.status == DerivativeStatus.OK
    assert preview_deriv.tool == "gltfpack -si 0.5"

    preview_path = Path(preview_deriv.local_path)
    assert preview_path == derivatives.derivative_path(
        settings, blob_hash, DerivativeKind.GLB_PREVIEW
    )
    preview_bytes = preview_path.read_bytes()
    assert preview_bytes[:4] == _GLB_MAGIC
    assert len(preview_bytes) > 0


async def test_optimize_glb_below_threshold_generates_no_preview(
    db_session: AsyncSession,
    backend: LocalStorageBackend,
    seed_file,
    corpus: CorpusPaths,
) -> None:
    settings = get_settings()
    blob_hash = await _seed_blob_with_ok_glb(db_session, seed_file, corpus)
    db_session.add(BlobMeta(blob_hash=blob_hash, triangle_count=12))
    await db_session.commit()

    with sync_session() as session:
        blob = session.get(Blob, blob_hash)
        outcome = pipeline._optimize_glb_step(session, settings, backend, blob)

    assert outcome == "done"
    with sync_session() as session:
        preview = session.execute(
            select(Derivative).where(
                Derivative.blob_hash == blob_hash, Derivative.kind == DerivativeKind.GLB_PREVIEW
            )
        ).scalar_one_or_none()
    assert preview is None


async def test_optimize_glb_missing_binary_fails_job_with_clear_message(
    db_session: AsyncSession,
    seed_file,
    corpus: CorpusPaths,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    blob_hash = await _seed_blob_with_ok_glb(db_session, seed_file, corpus)

    job = Job(type="optimize_glb", subject_type="file", subject_id=1, state="queued")
    db_session.add(job)
    await db_session.commit()
    await db_session.refresh(job)

    monkeypatch.setenv("TDMM_GLTFPACK_PATH", "/definitely/not/a/real/gltfpack/binary")
    get_settings.cache_clear()
    try:
        with pytest.raises(RuntimeError, match="gltfpack not found"):
            pipeline.optimize_glb(str(job.id), blob_hash)
    finally:
        get_settings.cache_clear()

    await db_session.refresh(job)
    assert job.state == "failed"
    assert "gltfpack not found" in job.error
