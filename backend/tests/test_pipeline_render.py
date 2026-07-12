"""``render_thumb`` pipeline step tests (Task 6; SPEC pipeline rows 5-6;
RESEARCH §4): ``app.pipeline.render.render_glb_png`` as a pure function
against real f3d (no mocking the tool under test -- Global Constraints "Real
infra in tests"), then the registered step itself for both branches: mesh/cad
blobs render their already-converted ``glb`` derivative, png/jpg blobs go
straight to ``thumbs.make_thumbs_from_image`` on the original bytes.

Render assertions follow the brief's exact recipe: real PNG magic bytes, the
requested dimensions, and non-uniform pixel content
(``len(set(img.tobytes())) > 1``) to prove the render isn't just a blank
frame.
"""

from __future__ import annotations

from pathlib import Path

import pytest
import trimesh
from PIL import Image
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models import Blob, Derivative, Model, Revision
from app.models.enums import BlobFormat, BlobKind, DerivativeKind, DerivativeStatus
from app.pipeline import render
from app.services import derivatives
from app.storage.local import LocalStorageBackend
from app.tasks import pipeline
from app.tasks.base import sync_session
from tests.corpus import CorpusPaths

pytestmark = pytest.mark.usefixtures("library_root", "data_dir")

_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _distinct_byte_values(png_path: Path) -> int:
    with Image.open(png_path) as image:
        return len(set(image.tobytes()))


# ---------------------------------------------------------------------------
# app.pipeline.render.render_glb_png: pure function, real f3d.
# ---------------------------------------------------------------------------


def test_render_glb_png_produces_real_nonuniform_png_at_requested_size(tmp_path: Path) -> None:
    box = trimesh.creation.box(extents=(20.0, 10.0, 5.0))
    glb_path = tmp_path / "box.glb"
    box.export(glb_path)
    out_png = tmp_path / "out.png"

    render.render_glb_png(glb_path, out_png, size=512)

    assert out_png.read_bytes()[:8] == _PNG_MAGIC
    with Image.open(out_png) as image:
        assert image.size == (512, 512)
    assert _distinct_byte_values(out_png) > 1


def test_render_glb_png_engine_is_reused_across_calls(tmp_path: Path) -> None:
    """Two renders in a row must both succeed -- proving the cached engine
    (``scene.clear()`` between renders) tolerates reuse rather than only
    working once.
    """
    box = trimesh.creation.box(extents=(20.0, 10.0, 5.0))
    glb_path = tmp_path / "box.glb"
    box.export(glb_path)

    out_1 = tmp_path / "out1.png"
    out_2 = tmp_path / "out2.png"
    render.render_glb_png(glb_path, out_1, size=256)
    render.render_glb_png(glb_path, out_2, size=256)

    for out in (out_1, out_2):
        assert out.read_bytes()[:8] == _PNG_MAGIC
        with Image.open(out) as image:
            assert image.size == (256, 256)


# ---------------------------------------------------------------------------
# The registered `render_thumb` step, called directly (Task 3-5 convention).
# ---------------------------------------------------------------------------


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
    """Seed a file/blob and a real, ``ok`` ``glb`` derivative for it --
    mirrors ``test_pipeline_optimize.py``'s helper of the same shape.
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


async def test_render_thumb_mesh_renders_and_publishes_both_thumbs(
    db_session: AsyncSession,
    backend: LocalStorageBackend,
    seed_file,
    corpus: CorpusPaths,
) -> None:
    settings = get_settings()
    blob_hash = await _seed_blob_with_ok_glb(db_session, seed_file, corpus)

    with sync_session() as session:
        blob = session.get(Blob, blob_hash)
        outcome = pipeline._render_thumb_step(session, settings, backend, blob)

    assert outcome == "done"

    p1024 = derivatives.derivative_path(settings, blob_hash, DerivativeKind.THUMB_1024)
    p256 = derivatives.derivative_path(settings, blob_hash, DerivativeKind.THUMB_256)

    assert p1024.read_bytes()[:8] == _PNG_MAGIC
    assert p256.read_bytes()[:8] == _PNG_MAGIC
    with Image.open(p1024) as image:
        assert image.size == (1024, 1024)
    with Image.open(p256) as image:
        assert image.size == (256, 256)
    assert _distinct_byte_values(p1024) > 1

    with sync_session() as session:
        rows = {
            d.kind: d
            for d in session.query(Derivative).filter(Derivative.blob_hash == blob_hash).all()
            if d.kind in (DerivativeKind.THUMB_1024, DerivativeKind.THUMB_256)
        }
    assert rows[DerivativeKind.THUMB_1024].status == DerivativeStatus.OK
    assert rows[DerivativeKind.THUMB_1024].tool == "f3d"
    assert rows[DerivativeKind.THUMB_256].status == DerivativeStatus.OK
    assert rows[DerivativeKind.THUMB_256].tool == "f3d"


async def test_render_thumb_skips_when_both_thumbs_already_ok(
    db_session: AsyncSession,
    backend: LocalStorageBackend,
    seed_file,
    corpus: CorpusPaths,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = get_settings()
    blob_hash = await _seed_blob_with_ok_glb(db_session, seed_file, corpus)

    with sync_session() as session:
        blob = session.get(Blob, blob_hash)
        first = pipeline._render_thumb_step(session, settings, backend, blob)
    assert first == "done"

    def _boom(*args, **kwargs):
        raise AssertionError("render_glb_png must not be called again once thumbs are ok")

    monkeypatch.setattr(render, "render_glb_png", _boom)

    with sync_session() as session:
        blob = session.get(Blob, blob_hash)
        second = pipeline._render_thumb_step(session, settings, backend, blob)

    assert second == "skipped"


async def test_render_thumb_missing_glb_derivative_raises(
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
            pipeline._render_thumb_step(session, settings, backend, blob)


async def test_render_thumb_render_failure_marks_both_derivatives_failed(
    db_session: AsyncSession,
    backend: LocalStorageBackend,
    seed_file,
    corpus: CorpusPaths,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Global Constraints "Failure semantics": a render failure must mark
    the derivative row(s) ``failed`` (with ``error``/``tool``) AND fail the
    job -- not just fail the job while leaving THUMB_1024/256 with no row at
    all, which is what a naive "only touch derivative rows on success" flow
    would do.
    """
    settings = get_settings()
    blob_hash = await _seed_blob_with_ok_glb(db_session, seed_file, corpus)

    def _boom(*args, **kwargs):
        raise RuntimeError("simulated f3d render failure")

    monkeypatch.setattr(render, "render_glb_png", _boom)

    with sync_session() as session:
        blob = session.get(Blob, blob_hash)
        with pytest.raises(RuntimeError, match="simulated f3d render failure"):
            pipeline._render_thumb_step(session, settings, backend, blob)

    with sync_session() as session:
        rows = {
            d.kind: d
            for d in session.query(Derivative).filter(Derivative.blob_hash == blob_hash).all()
            if d.kind in (DerivativeKind.THUMB_1024, DerivativeKind.THUMB_256)
        }
    assert rows[DerivativeKind.THUMB_1024].status == DerivativeStatus.FAILED
    assert rows[DerivativeKind.THUMB_1024].tool == "f3d"
    assert "simulated f3d render failure" in rows[DerivativeKind.THUMB_1024].error
    assert rows[DerivativeKind.THUMB_256].status == DerivativeStatus.FAILED
    assert rows[DerivativeKind.THUMB_256].tool == "f3d"


async def test_render_thumb_image_blob_uses_pillow(
    db_session: AsyncSession,
    backend: LocalStorageBackend,
    seed_file,
    corpus: CorpusPaths,
) -> None:
    settings = get_settings()
    model, revision = await _seed_model_and_revision(db_session)
    content = corpus.red_png.read_bytes()
    file = await seed_file(
        model, revision, "cover.png", content, blob_format=BlobFormat.PNG, blob_kind=BlobKind.IMAGE
    )

    with sync_session() as session:
        blob = session.get(Blob, file.blob_hash)
        outcome = pipeline._render_thumb_step(session, settings, backend, blob)

    assert outcome == "done"

    p1024 = derivatives.derivative_path(settings, file.blob_hash, DerivativeKind.THUMB_1024)
    p256 = derivatives.derivative_path(settings, file.blob_hash, DerivativeKind.THUMB_256)
    assert p1024.read_bytes()[:8] == _PNG_MAGIC
    assert p256.read_bytes()[:8] == _PNG_MAGIC
    # `red.png` is 64x64 -- `make_thumbs_from_image` never upscales.
    with Image.open(p1024) as image:
        assert image.size == (64, 64)

    with sync_session() as session:
        deriv = (
            session.query(Derivative)
            .filter(
                Derivative.blob_hash == file.blob_hash, Derivative.kind == DerivativeKind.THUMB_1024
            )
            .one()
        )
    assert deriv.tool == "pillow"


async def test_render_thumb_webp_blob_uses_pillow(
    db_session: AsyncSession,
    backend: LocalStorageBackend,
    seed_file,
    corpus: CorpusPaths,
) -> None:
    """feat/import-fidelity T1: ``BlobFormat.WEBP`` must route through the
    same image branch as png/jpg (``_IMAGE_FORMATS``), not the mesh/glb
    branch -- a blob whose format is webp but got missed there would blow up
    on the ``glb missing`` ``RuntimeError`` instead of rendering a thumb.
    """
    settings = get_settings()
    model, revision = await _seed_model_and_revision(db_session)
    content = corpus.red_webp.read_bytes()
    file = await seed_file(
        model,
        revision,
        "cover.webp",
        content,
        blob_format=BlobFormat.WEBP,
        blob_kind=BlobKind.IMAGE,
    )

    with sync_session() as session:
        blob = session.get(Blob, file.blob_hash)
        outcome = pipeline._render_thumb_step(session, settings, backend, blob)

    assert outcome == "done"

    p1024 = derivatives.derivative_path(settings, file.blob_hash, DerivativeKind.THUMB_1024)
    p256 = derivatives.derivative_path(settings, file.blob_hash, DerivativeKind.THUMB_256)
    # `_publish_thumb` always re-encodes as PNG regardless of the source
    # format -- both derivatives are PNGs on disk even though the source
    # blob was webp.
    assert p1024.read_bytes()[:8] == _PNG_MAGIC
    assert p256.read_bytes()[:8] == _PNG_MAGIC
    with Image.open(p1024) as image:
        assert image.size == (64, 64)

    with sync_session() as session:
        deriv = (
            session.query(Derivative)
            .filter(
                Derivative.blob_hash == file.blob_hash, Derivative.kind == DerivativeKind.THUMB_1024
            )
            .one()
        )
    assert deriv.tool == "pillow"


# ---------------------------------------------------------------------------
# End-to-end: the registered step actually runs through the full pipeline
# now that Task 6 fills it in (mesh chains no longer stop at optimize_glb).
# ---------------------------------------------------------------------------


async def test_stl_upload_pipeline_runs_through_render_thumb(
    authenticated_client,
    corpus: CorpusPaths,
) -> None:
    response = await authenticated_client.post(
        "/api/models", json={"name": "Render Pipeline Target"}
    )
    assert response.status_code == 201, response.text
    body = response.json()
    revision_id = body["current_revision"]["id"]

    upload = await authenticated_client.put(
        "/api/uploads",
        params={"model_id": body["id"], "revision_id": revision_id, "rel_path": "part.stl"},
        content=corpus.box_stl.read_bytes(),
    )
    assert upload.status_code == 201, upload.text

    jobs_resp = await authenticated_client.get("/api/jobs")
    jobs_list = jobs_resp.json()
    for step in ("extract_metadata", "convert_to_glb", "optimize_glb", "render_thumb"):
        step_job = next(j for j in jobs_list if j["type"] == step)
        assert step_job["state"] == "done", (step, step_job)
