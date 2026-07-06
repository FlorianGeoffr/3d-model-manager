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
import time
import uuid
from collections.abc import Callable
from typing import Literal

from celery import Task
from sqlalchemy.orm import Session as SyncSession

from app.config import Settings, get_settings
from app.models import Blob, Job
from app.models.enums import BlobFormat
from app.services import jobs
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
