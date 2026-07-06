"""The per-blob processing pipeline driver (SPEC "Processing pipeline";
Global Constraints "Pipeline shape" / "Pipeline jobs" / "Failure semantics").

``PIPELINE_STEPS`` is the format-keyed step order (Global Constraints table,
verbatim); ``next_step`` walks it. Each step is a Celery task registered with
``@pipeline_step("<name>")`` into ``STEP_TASKS``, keyed by the bare step name
(matching ``PIPELINE_STEPS`` entries, NOT Celery's dotted task name). Task 2
registers no real steps -- ``extract_metadata``/``convert_to_glb``/
``optimize_glb``/``render_thumb``/``extract_embedded_thumbs`` land in Tasks
3-6, each calling straight into ``run_step`` (this module's shared runner)
from a task body that just resolves its own ``StepFn`` closure.

``enqueue_step_sync``/``start_pipeline_sync`` are deliberately a NO-OP for a
step name that isn't (yet) in ``STEP_TASKS``: Task 2 ships the real
``PIPELINE_STEPS`` table before any of its steps are implemented, so e.g. an
STL upload resolves ``next_step`` to ``"extract_metadata"`` well before Task
3 registers that name -- without this guard, every real upload would crash
dispatching a step nothing has implemented yet (SPEC Task 2 Accept: uploading
any file works end-to-end with the store job followed by "(empty or stubbed)
pipeline dispatch"). Once a task lands, its name simply starts resolving and
the pipeline picks up from wherever it last stopped.

Dispatch failures from ``enqueue_step_sync`` (including, under the test
suite's eager Celery mode, the dispatched step's own body raising) are
best-effort and never propagate to the caller -- mirroring
``services.jobs._publish``'s reasoning: the caller here is always mid-
pipeline (``start_pipeline_sync`` right after a store job just committed
``done``, or ``run_step``'s own tail right after marking the CURRENT step
``done``), so a problem dispatching the NEXT step must never bubble up and
retroactively flip that already-settled, unrelated job back to ``failed``.
Contrast this with ``services.jobs.retry_job``'s pipeline-step branch, where
the caller IS the thing being retried -- there, a dispatch failure is exactly
what the caller (a human clicking retry) needs to see.
"""

from __future__ import annotations

import logging
import os
import subprocess
import tempfile
import time
import uuid
import zipfile
from collections.abc import Callable
from pathlib import Path
from typing import Literal

import trimesh
from celery import Task
from sqlalchemy import select
from sqlalchemy.orm import Session as SyncSession

from app.config import Settings, get_settings
from app.models import Blob, BlobMeta, Derivative, Job
from app.models.enums import BlobFormat, DerivativeKind, DerivativeStatus
from app.pipeline import convert, meshload, slicedmeta, thumbs
from app.services import derivatives, jobs
from app.storage.base import StorageBackend
from app.storage.registry import get_backend
from app.tasks import base
from app.tasks.celery_app import celery_app

logger = logging.getLogger(__name__)

# Global Constraints "Pipeline shape": per-blob step order, keyed by format.
PIPELINE_STEPS: dict[BlobFormat, tuple[str, ...]] = {
    BlobFormat.STL: ("extract_metadata", "convert_to_glb", "optimize_glb", "render_thumb"),
    BlobFormat.OBJ: ("extract_metadata", "convert_to_glb", "optimize_glb", "render_thumb"),
    BlobFormat.THREEMF: (
        "extract_metadata",
        "extract_embedded_thumbs",
        "convert_to_glb",
        "optimize_glb",
        "render_thumb",
    ),
    BlobFormat.GCODE_3MF: ("extract_metadata", "extract_embedded_thumbs"),
    BlobFormat.GCODE: ("extract_metadata",),
    BlobFormat.STEP: ("convert_to_glb", "extract_metadata", "optimize_glb", "render_thumb"),
    BlobFormat.IGES: ("convert_to_glb", "extract_metadata", "optimize_glb", "render_thumb"),
    BlobFormat.PNG: ("render_thumb",),
    BlobFormat.JPG: ("render_thumb",),
    BlobFormat.OTHER: (),
}

# Populated by @pipeline_step("<name>"); keyed by bare step name.
STEP_TASKS: dict[str, Task] = {}

# Global Constraints "Failure semantics": I/O retries 3x exponential backoff,
# transient errors only -- NOT StorageKeyNotFound/parse errors, which are
# deterministic and retrying them would just waste time before the same
# failure. Tests monkeypatch the delays to zeros.
TRANSIENT_ERRORS: tuple[type[BaseException], ...] = (OSError, ConnectionError)
TRANSIENT_RETRY_DELAYS: tuple[float, ...] = (1.0, 4.0, 16.0)


class UnsupportedBlobError(Exception):
    """Raised by a step's ``StepFn`` when the blob is a format/shape the
    tool can never handle (Global Constraints "Failure semantics":
    format-can't-ever -> derivative ``status="unsupported"``, job ``done``).
    Derivative bookkeeping stays inside the step function; ``run_step`` only
    maps this to the ``"unsupported"`` outcome and proceeds as if the step
    succeeded.
    """


StepOutcome = Literal["done", "skipped", "unsupported"]
StepFn = Callable[[SyncSession, Settings, StorageBackend, Blob], StepOutcome]


def pipeline_step(name: str) -> Callable[[Callable[[str, str], None]], Task]:
    """Decorator registering a Celery task body under
    ``app.tasks.pipeline.<name>`` (Celery's dotted task name) and, keyed by
    the bare ``name``, in ``STEP_TASKS`` (what ``enqueue_step_sync``/
    ``retry_job`` dispatch through). The wrapped function's signature is the
    task body itself: ``(job_id: str, blob_hash: str) -> None`` -- Global
    Constraints "Pipeline jobs" task-args convention -- and is expected to
    call ``run_step`` with its own ``StepFn``.
    """

    def decorator(fn: Callable[[str, str], None]) -> Task:
        task = celery_app.task(name=f"app.tasks.pipeline.{name}")(fn)
        STEP_TASKS[name] = task
        return task

    return decorator


def next_step(fmt: BlobFormat, after: str | None) -> str | None:
    """The step that should run next for ``fmt``, given the name of the last
    completed step (``after``). ``after=None`` means "give me the first
    step". Returns ``None`` when there's nothing left to run: past the end of
    ``fmt``'s steps, ``fmt`` has no steps at all, or ``after`` isn't one of
    ``fmt``'s step names.
    """
    steps = PIPELINE_STEPS.get(fmt, ())
    if after is None:
        return steps[0] if steps else None
    try:
        index = steps.index(after)
    except ValueError:
        return None
    return steps[index + 1] if index + 1 < len(steps) else None


def enqueue_step_sync(session: SyncSession, *, step: str, blob_hash: str, file_id: int) -> None:
    """Create a queued ``jobs`` row for ``step`` and dispatch its Celery
    task -- a no-op if ``step`` has no registered task yet (see module
    docstring). Best-effort: a dispatch failure (including, under eager-mode
    tests, the dispatched step re-raising its own failure) is logged and
    absorbed here rather than propagated -- see module docstring for why.
    """
    task = STEP_TASKS.get(step)
    if task is None:
        return

    job = jobs.create_job_sync(
        session, id=uuid.uuid4(), type=step, subject_type="file", subject_id=file_id
    )
    try:
        task.apply_async(args=[str(job.id), blob_hash], task_id=str(job.id))
    except Exception as exc:
        session.refresh(job)
        if job.state == jobs.STATE_QUEUED:
            # The task body never got to run at all (a real broker-dispatch
            # failure) -- nothing else will ever mark this row, so it must
            # not strand `queued` forever.
            jobs.mark_failed(session, str(job.id), f"dispatch failed: {exc}")
        else:
            # Eager-mode test run: the step's own body already drove its job
            # to a terminal state (failed, typically) through run_step's own
            # exception handling before re-raising here. That's the correct,
            # final word on ITS row -- nothing to do.
            logger.warning(
                "pipeline step %s (job %s) raised during dispatch; its own terminal state stands",
                step,
                job.id,
                exc_info=True,
            )


def start_pipeline_sync(session: SyncSession, *, blob_hash: str, file_id: int) -> None:
    """Enqueue the first pipeline step for a freshly-stored blob, if its
    format has any steps at all.
    """
    blob = session.get(Blob, blob_hash)
    if blob is None:
        return
    step = next_step(blob.format, None)
    if step is not None:
        enqueue_step_sync(session, step=step, blob_hash=blob_hash, file_id=file_id)


def pipeline_completed_hook(session: SyncSession, blob_hash: str) -> None:
    """Called once a blob has run its last pipeline step. No-op in Task 2;
    Task 6 replaces this with the per-revision assembly-thumb trigger.
    """


def run_step(job_id: str, blob_hash: str, step: str, fn: StepFn) -> None:
    """Shared runner for every pipeline step task (used by Tasks 3-6's
    ``@pipeline_step``-decorated bodies): marks the job running, loads the
    blob, calls ``fn`` (retrying transient I/O errors per
    ``TRANSIENT_ERRORS``/``TRANSIENT_RETRY_DELAYS``), marks the job done, and
    either enqueues the next step for this format or -- on the last step --
    calls ``pipeline_completed_hook``. Any non-transient exception from
    ``fn`` (after transient retries are exhausted too) marks the job
    ``failed`` and re-raises; ``UnsupportedBlobError`` instead maps to the
    ``"unsupported"`` outcome and proceeds normally.
    """
    with base.sync_session() as session:
        jobs.mark_running(session, job_id)

    with base.sync_session() as session:
        blob = session.get(Blob, blob_hash)
        if blob is None:
            jobs.mark_failed(session, job_id, f"blob {blob_hash} not found")
            return
        fmt = blob.format

    settings = get_settings()
    backend = get_backend(settings)

    try:
        outcome: StepOutcome
        attempt = 0
        while True:
            try:
                with base.sync_session() as session:
                    blob = session.get(Blob, blob_hash)
                    outcome = fn(session, settings, backend, blob)
                break
            except UnsupportedBlobError:
                outcome = "unsupported"
                break
            except TRANSIENT_ERRORS as exc:
                if attempt >= len(TRANSIENT_RETRY_DELAYS):
                    raise
                logger.warning(
                    "transient error running pipeline step %s for blob %s (attempt %d): %s",
                    step,
                    blob_hash,
                    attempt + 1,
                    exc,
                    exc_info=True,
                )
                time.sleep(TRANSIENT_RETRY_DELAYS[attempt])
                attempt += 1

        logger.debug("pipeline step %s for blob %s finished: %s", step, blob_hash, outcome)

        with base.sync_session() as session:
            jobs.mark_done(session, job_id)
            job = session.get(Job, uuid.UUID(job_id))
            nxt = next_step(fmt, step)
            if nxt is not None:
                enqueue_step_sync(session, step=nxt, blob_hash=blob_hash, file_id=job.subject_id)
            else:
                pipeline_completed_hook(session, blob_hash)
    except Exception as exc:
        with base.sync_session() as session:
            jobs.mark_failed(session, job_id, str(exc))
        raise


# ---------------------------------------------------------------------------
# extract_metadata (Task 3; SPEC pipeline row 1; RESEARCH §1/§3): mesh stats
# for stl/obj/3mf, sliced-file/gcode-header fields for gcode_3mf/gcode, and
# mesh stats read back off the already-converted GLB derivative for
# step/iges.
# ---------------------------------------------------------------------------

_MESH_FORMATS = (BlobFormat.STL, BlobFormat.OBJ, BlobFormat.THREEMF)
_CAD_FORMATS = (BlobFormat.STEP, BlobFormat.IGES)


def _mesh_blob_meta(blob_hash: str, mesh: trimesh.Trimesh, tool: str) -> BlobMeta:
    """Build the ``BlobMeta`` row for a loaded mesh -- shared by the native
    stl/obj/3mf branch and the CAD (GLB-derived) branch below, which compute
    the same stats off differently-sourced ``trimesh.Trimesh`` objects.
    """
    return BlobMeta(
        blob_hash=blob_hash,
        triangle_count=len(mesh.faces),
        dims_mm=[float(x) for x in mesh.extents],
        volume_cm3=(mesh.volume / 1000) if mesh.is_watertight else None,
        surface_area_cm2=mesh.area / 100,
        is_watertight=bool(mesh.is_watertight),
        raw={"tool": tool},
    )


def _sliced_blob_meta(blob_hash: str, sliced: slicedmeta.SlicedMeta) -> BlobMeta:
    return BlobMeta(
        blob_hash=blob_hash,
        print_time_s=sliced.print_time_s,
        filament_g=sliced.filament_g,
        filament_m=sliced.filament_m,
        filament_types=sliced.filament_types,
        layer_height=sliced.layer_height,
        nozzle=sliced.nozzle,
        printer_model=sliced.printer_model,
        plate_count=sliced.plate_count,
        raw={"plates": sliced.plates, "tool": "zipfile"},
    )


def _gcode_blob_meta(blob_hash: str, header: slicedmeta.GcodeMeta) -> BlobMeta:
    return BlobMeta(
        blob_hash=blob_hash,
        print_time_s=header.print_time_s,
        filament_g=header.filament_g,
        filament_m=header.filament_m,
        raw={"header": header.raw, "tool": "gcode-header"},
    )


def _cad_blob_meta(session: SyncSession, settings: Settings, blob: Blob) -> BlobMeta:
    """step/iges: read mesh stats off the already-converted GLB derivative
    (Global Constraints "Pipeline shape": ``convert_to_glb`` runs before
    ``extract_metadata`` for CAD formats specifically so OCCT only
    tessellates once) rather than re-tessellating the original CAD file.
    """
    glb = session.execute(
        select(Derivative).where(
            Derivative.blob_hash == blob.hash, Derivative.kind == DerivativeKind.GLB
        )
    ).scalar_one_or_none()
    if glb is None or glb.status != DerivativeStatus.OK:
        raise RuntimeError("glb derivative not ready; pipeline order broken")

    glb_path = derivatives.derivative_path(settings, blob.hash, DerivativeKind.GLB)
    mesh = meshload.to_single_mesh(trimesh.load(glb_path))
    return _mesh_blob_meta(blob.hash, mesh, "glb-derived")


def _extract_metadata_step(
    session: SyncSession, settings: Settings, backend: StorageBackend, blob: Blob
) -> StepOutcome:
    """``extract_metadata``'s ``StepFn``: skip if a ``BlobMeta`` row already
    exists for this blob (Global Constraints "Pipeline jobs": steps are
    idempotent), otherwise branch on ``blob.format`` and upsert one.
    """
    if session.get(BlobMeta, blob.hash) is not None:
        return "skipped"

    fmt = blob.format
    if fmt in _MESH_FORMATS:
        with tempfile.TemporaryDirectory(prefix="tdmm-pipe-") as tmp:
            path = derivatives.fetch_blob_to_temp(
                session, backend, blob.hash, Path(tmp), f".{fmt.value}"
            )
            mesh, tool = meshload.load_mesh(path, fmt)
        meta = _mesh_blob_meta(blob.hash, mesh, tool)
    elif fmt is BlobFormat.GCODE_3MF:
        with tempfile.TemporaryDirectory(prefix="tdmm-pipe-") as tmp:
            path = derivatives.fetch_blob_to_temp(session, backend, blob.hash, Path(tmp), ".3mf")
            meta = _sliced_blob_meta(blob.hash, slicedmeta.parse_gcode_3mf(path))
    elif fmt is BlobFormat.GCODE:
        with tempfile.TemporaryDirectory(prefix="tdmm-pipe-") as tmp:
            path = derivatives.fetch_blob_to_temp(session, backend, blob.hash, Path(tmp), ".gcode")
            meta = _gcode_blob_meta(blob.hash, slicedmeta.parse_gcode_header(path))
    elif fmt in _CAD_FORMATS:
        meta = _cad_blob_meta(session, settings, blob)
    else:
        # png/jpg/other never route extract_metadata here at all (Global
        # Constraints "Pipeline shape" table has no extract_metadata entry
        # for them) -- defensive only.
        raise UnsupportedBlobError(f"extract_metadata: unsupported format {fmt}")

    session.merge(meta)
    session.commit()
    return "done"


@pipeline_step("extract_metadata")
def extract_metadata(job_id: str, blob_hash: str) -> None:
    run_step(job_id, blob_hash, "extract_metadata", _extract_metadata_step)


# ---------------------------------------------------------------------------
# extract_embedded_thumbs (Task 4; SPEC pipeline row 2; RESEARCH §3/§4:
# assimp can't parse Bambu 3MF, so this step -- reading the slicer's own
# embedded preview PNG(s) -- is the only thumbnail source for `3mf`/
# `gcode_3mf` until a mesh render exists; `gcode_3mf` never reaches
# convert_to_glb/render_thumb at all (Global Constraints "Pipeline shape").
# ---------------------------------------------------------------------------

# The one hardcoded guess this step is allowed to make when
# `model_settings.config` doesn't resolve a thumbnail at all (missing,
# unparseable, or every `thumbnail_file` entry points at a member that isn't
# actually in the zip) -- SPEC pipeline row 2: "fallback probe
# Metadata/plate_1.png -- never assume beyond that".
_FALLBACK_THUMBNAIL_MEMBER = "Metadata/plate_1.png"
_PLATE_ONE_INDEX = 1


def _resolve_plate_thumbnails(zf: zipfile.ZipFile) -> list[tuple[int, str]]:
    """Per-plate ``(index, zip member name)`` pairs for every plate whose
    ``model_settings.config`` ``thumbnail_file`` entry resolves to a member
    actually present in the zip, ascending by index (empty if
    `model_settings.config` is missing/unparseable/has no plates at all).
    Falls back to a single ``(1, _FALLBACK_THUMBNAIL_MEMBER)`` entry when
    that resolves nothing but the fixed fallback path exists anyway.
    """
    names = set(zf.namelist())
    model_settings = slicedmeta.read_zip_member(zf, slicedmeta.MODEL_SETTINGS_PATH)
    plate_files = slicedmeta.parse_model_settings(model_settings)

    resolved = sorted(
        (index, thumb)
        for index, info in plate_files.items()
        if (thumb := info.get("thumbnail_file")) and thumb in names
    )
    if resolved:
        return resolved
    if _FALLBACK_THUMBNAIL_MEMBER in names:
        return [(_PLATE_ONE_INDEX, _FALLBACK_THUMBNAIL_MEMBER)]
    return []


def _thumbs_already_ok(session: SyncSession, blob_hash: str) -> bool:
    """Global Constraints "Pipeline jobs": idempotent -- both thumb
    derivatives already ``ok`` means this step has nothing left to do.
    """
    ok_kinds = set(
        session.execute(
            select(Derivative.kind).where(
                Derivative.blob_hash == blob_hash,
                Derivative.kind.in_((DerivativeKind.THUMB_1024, DerivativeKind.THUMB_256)),
                Derivative.status == DerivativeStatus.OK,
            )
        ).scalars()
    )
    return ok_kinds == {DerivativeKind.THUMB_1024, DerivativeKind.THUMB_256}


def _publish_plate_thumb(data: bytes, settings: Settings, blob_hash: str, index: int) -> None:
    """Copy one plate's embedded PNG bytes verbatim to its rowless
    ``plate_thumb_path`` -- no decoding/validation (Bambu's known
    blank-when-headless PNGs are accepted as-is), just an atomic publish.
    """
    derivatives.publish_bytes(data, derivatives.plate_thumb_path(settings, blob_hash, index))


def _publish_embedded_thumbs(
    session: SyncSession, settings: Settings, blob_hash: str, image_bytes: bytes
) -> None:
    """Build+publish the thumb_1024/thumb_256 derivatives from one embedded
    preview image (``tool="embedded"``). A corrupted embedded PNG is a
    deterministic parse failure (Global Constraints "Failure semantics":
    derivative row ``failed`` with ``error``/``tool``, AND the job itself
    fails) -- ``thumbs.make_thumbs_from_image`` already turns Pillow's own
    ``OSError``-subclass decode failures into a plain ``ValueError`` so
    ``run_step`` never mistakes this for transient I/O.
    """
    deriv_1024 = derivatives.upsert_derivative(session, blob_hash, DerivativeKind.THUMB_1024)
    deriv_256 = derivatives.upsert_derivative(session, blob_hash, DerivativeKind.THUMB_256)
    try:
        p1024, p256 = thumbs.make_thumbs_from_image(image_bytes, settings, blob_hash)
    except Exception as exc:
        derivatives.mark_derivative(
            session, deriv_1024, status=DerivativeStatus.FAILED, tool="embedded", error=str(exc)
        )
        derivatives.mark_derivative(
            session, deriv_256, status=DerivativeStatus.FAILED, tool="embedded", error=str(exc)
        )
        raise
    derivatives.mark_derivative(
        session, deriv_1024, status=DerivativeStatus.OK, local_path=str(p1024), tool="embedded"
    )
    derivatives.mark_derivative(
        session, deriv_256, status=DerivativeStatus.OK, local_path=str(p256), tool="embedded"
    )


def _extract_embedded_thumbs_step(
    session: SyncSession, settings: Settings, backend: StorageBackend, blob: Blob
) -> StepOutcome:
    """``extract_embedded_thumbs``'s ``StepFn``: resolve embedded preview
    PNG(s) out of the 3mf/gcode_3mf zip via ``model_settings.config`` (or the
    fixed fallback probe), then branch on format -- ``gcode_3mf`` extracts
    every resolved plate to its own rowless ``plate_thumb_path`` and, if
    plate 1 was among them, also builds the thumb derivatives from it;
    plain ``3mf`` project files only ever build the thumb derivatives, from
    the first (lowest-index) resolved plate. No resolvable thumbnail at all
    is not a failure -- ``render_thumb`` (Task 6) will rasterize a mesh
    later, so a sliced blob simply has no thumb until then (SPEC pipeline
    row 2).
    """
    if _thumbs_already_ok(session, blob.hash):
        return "skipped"

    with tempfile.TemporaryDirectory(prefix="tdmm-pipe-") as tmp:
        path = derivatives.fetch_blob_to_temp(session, backend, blob.hash, Path(tmp), ".3mf")
        with zipfile.ZipFile(path) as zf:
            plates = _resolve_plate_thumbnails(zf)
            plate_bytes = {index: zf.read(member) for index, member in plates}

    if blob.format is BlobFormat.GCODE_3MF:
        for index, data in plate_bytes.items():
            _publish_plate_thumb(data, settings, blob.hash, index)
        source_bytes = plate_bytes.get(_PLATE_ONE_INDEX)
    else:
        source_bytes = next(iter(plate_bytes.values()), None)

    if source_bytes is None:
        return "done"

    _publish_embedded_thumbs(session, settings, blob.hash, source_bytes)
    return "done"


@pipeline_step("extract_embedded_thumbs")
def extract_embedded_thumbs(job_id: str, blob_hash: str) -> None:
    run_step(job_id, blob_hash, "extract_embedded_thumbs", _extract_embedded_thumbs_step)


# ---------------------------------------------------------------------------
# convert_to_glb (Task 5; SPEC pipeline row 3; RESEARCH §2): per-format
# conversion to the raw, uncompressed `glb` derivative -- the one GLB
# artifact f3d/trimesh/OCCT ever read back (Global Constraints "Two GLB
# artifacts per blob"; ``optimize_glb`` below produces the meshopt-compressed
# browser artifacts separately, never touching this row). The actual
# trimesh/lib3mf/cascadio/OCP conversion work lives in
# ``app.pipeline.convert``/``app.pipeline.cad``; this step is just the
# derivative/job bookkeeping around it, matching ``extract_metadata``'s shape.
# ---------------------------------------------------------------------------


def _glb_derivative(session: SyncSession, blob_hash: str) -> Derivative | None:
    return session.execute(
        select(Derivative).where(
            Derivative.blob_hash == blob_hash, Derivative.kind == DerivativeKind.GLB
        )
    ).scalar_one_or_none()


def _convert_to_glb_step(
    session: SyncSession, settings: Settings, backend: StorageBackend, blob: Blob
) -> StepOutcome:
    """``convert_to_glb``'s ``StepFn``: skip if the ``glb`` derivative is
    already ``ok`` (Global Constraints "Pipeline jobs": idempotent), otherwise
    convert into a temp file staged in the derivative's own parent directory
    (so the final ``publish_file`` rename never crosses a filesystem
    boundary -- ``convert.convert_to_glb_file``'s trimesh/cascadio/OCP calls
    write to that path directly, unlike the in-memory-bytes steps that use
    ``derivatives.publish_bytes``) and publishes it.
    """
    existing = _glb_derivative(session, blob.hash)
    if existing is not None and existing.status == DerivativeStatus.OK:
        return "skipped"

    deriv = derivatives.upsert_derivative(session, blob.hash, DerivativeKind.GLB)
    dest = derivatives.derivative_path(settings, blob.hash, DerivativeKind.GLB)
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=dest.parent, prefix=".tdmm-glb-", suffix=".glb")
    os.close(fd)
    tmp_path = Path(tmp_name)
    try:
        with tempfile.TemporaryDirectory(prefix="tdmm-pipe-") as tmp:
            src = derivatives.fetch_blob_to_temp(
                session, backend, blob.hash, Path(tmp), f".{blob.format.value}"
            )
            tool = convert.convert_to_glb_file(src, blob.format, tmp_path)
    except Exception as exc:
        tmp_path.unlink(missing_ok=True)
        derivatives.mark_derivative(session, deriv, status=DerivativeStatus.FAILED, error=str(exc))
        raise
    derivatives.publish_file(tmp_path, dest)
    derivatives.mark_derivative(
        session, deriv, status=DerivativeStatus.OK, local_path=str(dest), tool=tool
    )
    return "done"


@pipeline_step("convert_to_glb")
def convert_to_glb(job_id: str, blob_hash: str) -> None:
    run_step(job_id, blob_hash, "convert_to_glb", _convert_to_glb_step)


# ---------------------------------------------------------------------------
# optimize_glb (Task 5; SPEC pipeline row 4; RESEARCH §5): gltfpack `-cc`
# meshopt-compresses the ok `glb` derivative into the rowless, browser-only
# `glb_web` file (Global Constraints "Two GLB artifacts per blob" -- the raw
# `glb` derivative this reads is NEVER rewritten), plus a `-si 0.5` decimated
# LOD (`glb_preview` DERIVATIVE row, unlike `glb_web`) once the blob's own
# triangle count clears ``PREVIEW_TRIANGLE_THRESHOLD``.
# ---------------------------------------------------------------------------

# SPEC pipeline row 4 / RESEARCH §5: LOD threshold above which a decimated
# `-si 0.5` preview is also generated. Single reference for this module and
# the Task 8 frontend mirror.
PREVIEW_TRIANGLE_THRESHOLD = 1_500_000


def _run_gltfpack(settings: Settings, args: list[str]) -> None:
    """Invoke gltfpack, turning its two failure modes into clear,
    deterministic exceptions. A missing binary raises ``FileNotFoundError``
    (an ``OSError`` subclass) -- deliberately NOT let through as-is, since
    ``run_step``'s ``TRANSIENT_ERRORS`` retry loop treats any bare
    ``OSError`` as transient, which would waste the whole retry budget
    re-running a binary that will never exist before finally surfacing the
    wrong (generic) error anyway.
    """
    try:
        result = subprocess.run(
            [settings.gltfpack_path, *args], capture_output=True, timeout=300, text=True
        )
    except FileNotFoundError as exc:
        raise RuntimeError(
            "gltfpack not found -- run scripts/fetch-gltfpack.sh (dev) / check image (docker)"
        ) from exc
    if result.returncode != 0:
        stderr_tail = (result.stderr or "").strip()[-2000:]
        raise RuntimeError(f"gltfpack failed (exit {result.returncode}): {stderr_tail}")


def _generate_preview_lod(
    session: SyncSession, settings: Settings, blob_hash: str, raw_glb: Path
) -> None:
    deriv = derivatives.upsert_derivative(session, blob_hash, DerivativeKind.GLB_PREVIEW)
    dest = derivatives.derivative_path(settings, blob_hash, DerivativeKind.GLB_PREVIEW)
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=dest.parent, prefix=".tdmm-glbpreview-", suffix=".glb")
    os.close(fd)
    tmp_path = Path(tmp_name)
    try:
        _run_gltfpack(settings, ["-i", str(raw_glb), "-o", str(tmp_path), "-si", "0.5", "-cc"])
    except Exception as exc:
        tmp_path.unlink(missing_ok=True)
        derivatives.mark_derivative(
            session, deriv, status=DerivativeStatus.FAILED, tool="gltfpack -si 0.5", error=str(exc)
        )
        raise
    derivatives.publish_file(tmp_path, dest)
    derivatives.mark_derivative(
        session, deriv, status=DerivativeStatus.OK, local_path=str(dest), tool="gltfpack -si 0.5"
    )


def _optimize_glb_step(
    session: SyncSession, settings: Settings, backend: StorageBackend, blob: Blob
) -> StepOutcome:
    """``optimize_glb``'s ``StepFn``: skip once the `glb_web` file already
    exists (Global Constraints "Pipeline jobs": idempotent) -- otherwise
    the ok `glb` derivative is a hard prerequisite (a broken pipeline order
    is a bug, not a retriable condition, hence the plain ``RuntimeError``
    rather than a derivative failure -- there's no derivative row to fail for
    the rowless `glb_web` output anyway).
    """
    glb_deriv = _glb_derivative(session, blob.hash)
    if glb_deriv is None or glb_deriv.status != DerivativeStatus.OK:
        raise RuntimeError("glb missing")

    web_path = derivatives.glb_web_path(settings, blob.hash)
    if web_path.exists():
        return "skipped"

    raw_glb = derivatives.derivative_path(settings, blob.hash, DerivativeKind.GLB)

    web_path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=web_path.parent, prefix=".tdmm-glbweb-", suffix=".glb")
    os.close(fd)
    tmp_path = Path(tmp_name)
    try:
        _run_gltfpack(settings, ["-i", str(raw_glb), "-o", str(tmp_path), "-cc"])
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise
    derivatives.publish_file(tmp_path, web_path)

    meta = session.get(BlobMeta, blob.hash)
    if (
        meta is not None
        and meta.triangle_count
        and meta.triangle_count > PREVIEW_TRIANGLE_THRESHOLD
    ):
        _generate_preview_lod(session, settings, blob.hash, raw_glb)

    return "done"


@pipeline_step("optimize_glb")
def optimize_glb(job_id: str, blob_hash: str) -> None:
    run_step(job_id, blob_hash, "optimize_glb", _optimize_glb_step)
