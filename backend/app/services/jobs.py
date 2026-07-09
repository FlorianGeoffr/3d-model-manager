"""Background job tracking (SPEC ``jobs``; "Processing pipeline": "every
task tracked in jobs", Task 6 interface decisions; Task 2 generalizes retry
to cover pipeline-step jobs too).

Split by execution context, matching the API(async)/worker(sync) boundary
documented in ``app.tasks.base``:

- ``create_job``, ``list_jobs``, ``get_job_or_404``, ``retry_job`` run on the
  API's async engine (called from ``app.api.uploads``/``app.api.jobs``).
- ``create_job_sync``, ``mark_running``, ``mark_done``, ``mark_failed`` run
  on the worker's sync engine, called from inside
  ``app.tasks.ingest.store_to_backend`` and ``app.tasks.pipeline``.

Each transition helper also publishes the SSE ``job.updated`` event (see
``app.services.events``) to ``tdmm:events``, best-effort (Task 2 review
finding): a Redis blip must never turn an already-committed state transition
into a lie the DB doesn't back up.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable

import anyio
from celery import Task
from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session as SyncSession

from app.config import Settings, get_settings
from app.models import File, Job, Revision
from app.services import events
from app.services import spool as spool_service

logger = logging.getLogger(__name__)

STATE_QUEUED = "queued"
STATE_RUNNING = "running"
STATE_DONE = "done"
STATE_FAILED = "failed"
# Task 8: formal dead-letter state -- distinct from a plain/early `failed`,
# auto-parked (see `mark_failed` below) once a job has exhausted its
# `max_attempts` ceiling, so the UI/operator can tell "worth retrying" apart
# from "will deterministically fail again" instead of a `failed` job being
# retryable forever.
STATE_DEAD = "dead"


# -- async: API-side -------------------------------------------------------


async def create_job(
    db: AsyncSession,
    *,
    id: uuid.UUID,
    type: str,
    subject_type: str | None,
    subject_id: int | None,
) -> Job:
    """Insert a new ``jobs`` row in ``queued`` state.

    ``id`` is passed explicitly rather than relying on the model's default
    (``app.api.uploads`` pre-generates it as the upload's spool token, so the
    job id doubles as the retry-time key into ``app.services.spool``).
    ``celery_id`` is set to the same value up front since the caller always
    dispatches with an explicit ``task_id=str(id)`` (see ``app.api.uploads``,
    ``retry_job`` below) -- this sidesteps a race where updating
    ``celery_id`` *after* dispatch could race a (test-only) eager task run
    that already committed the job's real terminal state through a
    completely separate (sync) session.
    """
    job = Job(
        id=id,
        celery_id=str(id),
        type=type,
        subject_type=subject_type,
        subject_id=subject_id,
        state=STATE_QUEUED,
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)
    return job


async def list_jobs(db: AsyncSession, *, state: str | None, limit: int) -> list[Job]:
    stmt = select(Job).order_by(Job.created_at.desc()).limit(limit)
    if state:
        stmt = stmt.where(Job.state == state)
    return list((await db.execute(stmt)).scalars().all())


async def get_job_or_404(db: AsyncSession, job_id: uuid.UUID) -> Job:
    job = await db.get(Job, job_id)
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"job {job_id} not found")
    return job


async def retry_job(db: AsyncSession, settings: Settings, job_id: uuid.UUID) -> Job:
    """Re-dispatch a ``failed`` (or ``dead``, Task 8) job, generalized
    (Task 2) over a small dispatch table keyed by ``job.type``:
    ``store_to_backend`` re-sends its still-spooled bytes; any name in
    ``app.tasks.pipeline.PIPELINE_STEPS`` re-runs that step against its
    subject file's current blob; ``render_assembly_thumb`` (Task 6) re-runs
    against its subject revision. ``migrate_storage`` (Task 6) never retries
    -- see the dedicated 409 below. Anything else 409s as an unknown job
    type. 409 if the job isn't ``failed``/``dead`` to begin with.

    ``dead`` (Task 8) is auto-park-only (``mark_failed`` parks a job there
    once it's exhausted ``max_attempts`` -- there's no automatic retry loop
    that would need to stop at ``dead``); this manual, operator-driven path
    is deliberately still allowed to retry one, as the escape hatch for "I
    fixed the underlying problem, try it again anyway."
    """
    job = await get_job_or_404(db, job_id)
    if job.state not in (STATE_FAILED, STATE_DEAD):
        raise HTTPException(status.HTTP_409_CONFLICT, f"job {job_id} is not in a failed state")

    if job.type == "store_to_backend":
        return await _retry_store_to_backend(db, settings, job)

    if job.type == "render_assembly_thumb":
        return await _retry_render_assembly_thumb(db, job)

    if job.type == "migrate_storage":
        # No retry path (Task 6): the job row has no payload column to stash
        # the failed migration's target config in, and there's nothing else
        # to re-derive it from. Simplest correct behavior -- point the
        # operator back at Settings to kick off a fresh migration rather
        # than inventing a payload-persistence detour for a rare, operator-
        # driven action.
        raise HTTPException(
            status.HTTP_409_CONFLICT, "migrations are re-run from Settings, not retried"
        )

    if job.type == "relocate_model_storage":
        # Same reasoning as `migrate_storage` above: the job row has no
        # payload column to stash `target_backend_id`/`mode` in, so there's
        # nothing to re-dispatch with. A relocate is also naturally re-runnable
        # from scratch (Workstream C task C3: already-relocated files are
        # skipped as no-ops), so pointing the operator back at the model's
        # own relocate action costs nothing beyond an extra click.
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "relocations are re-run from the model's Move/Copy action, not retried",
        )

    # Local import: app.tasks.pipeline imports app.services.jobs (for the
    # mark_*/create_job_sync helpers), so importing it back at module level
    # here would be a circular import -- same reasoning as
    # `_retry_store_to_backend`'s import of app.tasks.ingest below.
    from app.tasks.pipeline import PIPELINE_STEPS, STEP_TASKS

    pipeline_step_names = {name for steps in PIPELINE_STEPS.values() for name in steps}
    if job.type in pipeline_step_names:
        return await _retry_pipeline_step(db, job, STEP_TASKS[job.type])

    raise HTTPException(status.HTTP_409_CONFLICT, "unknown job type")


async def _dispatch(db: AsyncSession, job: Job, dispatch: Callable[[], object]) -> Job:
    """Run ``dispatch()`` (an ``apply_async`` call) and apply eager-mode-
    aware dispatch hardening (backlog: no more stranded ``queued`` rows).

    Under the test suite's ``task_eager_propagates``, ``apply_async`` runs
    the task body inline and re-raises whatever it raised -- which, for a
    step/store task, means it already ran ``mark_failed`` (or ``mark_done``)
    through its own sync session before the exception reached here.
    Overwriting that with "dispatch failed" would misreport a real task
    failure as a broker problem: if the job is STILL ``queued`` after the
    exception, the dispatch itself never got the task running at all -- mark
    it ``failed`` here and surface 502; otherwise the retry genuinely ran and
    its own terminal state (``failed``/``done``) is the answer -- return it
    as-is.
    """
    try:
        dispatch()
    except Exception as exc:
        await db.refresh(job)
        if job.state == STATE_QUEUED:
            job.state = STATE_FAILED
            job.error = f"dispatch failed: {exc}"
            await db.commit()
            await db.refresh(job)
            raise HTTPException(status.HTTP_502_BAD_GATEWAY, job.error) from exc
        return job
    await db.refresh(job)
    return job


async def _retry_store_to_backend(db: AsyncSession, settings: Settings, job: Job) -> Job:
    """The original (Task 6) ``store_to_backend`` retry: re-send the still-
    spooled bytes. 409 if the spool file is gone. ``attempts`` is left
    untouched here -- the task itself increments it on every run, so it's
    naturally "preserved" (i.e. keeps growing) across retries.
    """
    # Local import: app.tasks.ingest imports app.services.jobs (for the
    # mark_* helpers), so importing it back at module level here would be a
    # circular import. Delaying it to call time breaks the cycle.
    from app.tasks.ingest import store_to_backend

    path = spool_service.spool_path(settings, job.id)
    if not await anyio.to_thread.run_sync(path.exists):
        raise HTTPException(status.HTTP_409_CONFLICT, "spool file no longer exists; cannot retry")

    # Commit the "queued" transition BEFORE dispatching: in eager test mode
    # `apply_async` runs the task inline, through its own (sync) session,
    # driving the job all the way to running/done/failed and committing each
    # step. If we dispatched before committing, this (async) session's
    # in-memory `job.state = "queued"` would still be pending, and a later
    # `db.commit()` on THIS object would stomp the task's real terminal
    # state back to "queued".
    job.state = STATE_QUEUED
    job.error = None
    await db.commit()
    await db.refresh(job)

    return await _dispatch(
        db,
        job,
        lambda: store_to_backend.apply_async(
            args=[str(job.id), job.subject_id, str(path)], task_id=str(job.id)
        ),
    )


async def _retry_pipeline_step(db: AsyncSession, job: Job, task: Task) -> Job:
    """Re-run a pipeline-step job (Task 2) against its subject file's
    CURRENT blob -- 409 if that file no longer exists (e.g. deleted or
    superseded since the step last ran).
    """
    file = await db.get(File, job.subject_id)
    if file is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "subject file no longer exists")

    job.state = STATE_QUEUED
    job.error = None
    await db.commit()
    await db.refresh(job)

    return await _dispatch(
        db,
        job,
        lambda: task.apply_async(args=[str(job.id), file.blob_hash], task_id=str(job.id)),
    )


async def _retry_render_assembly_thumb(db: AsyncSession, job: Job) -> Job:
    """Re-run a ``render_assembly_thumb`` job (Task 6) against its subject
    REVISION -- 409 if that revision no longer exists. Unlike
    ``_retry_pipeline_step``, ``subject_id`` is a revision id, not a file id.
    """
    revision = await db.get(Revision, job.subject_id)
    if revision is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "subject revision no longer exists")

    job.state = STATE_QUEUED
    job.error = None
    await db.commit()
    await db.refresh(job)

    # Local import: app.tasks.pipeline imports app.services.jobs (for the
    # mark_*/create_job_sync helpers), so importing it back at module level
    # here would be a circular import -- same reasoning as the pipeline-step
    # import above.
    from app.tasks.pipeline import render_assembly_thumb

    return await _dispatch(
        db,
        job,
        lambda: render_assembly_thumb.apply_async(
            args=[str(job.id), revision.id], task_id=str(job.id)
        ),
    )


# -- sync: worker-side (see app.tasks.base) --------------------------------


def create_job_sync(
    session: SyncSession,
    *,
    id: uuid.UUID,
    type: str,
    subject_type: str | None,
    subject_id: int | None,
) -> Job:
    """Sync mirror of ``create_job`` above, for worker-side code
    (``app.tasks.pipeline.enqueue_step_sync``) that can't touch the API's
    async engine. Same reasoning applies: ``id``/``celery_id`` are set
    up-front to the same explicit value the caller always dispatches with.
    """
    job = Job(
        id=id,
        celery_id=str(id),
        type=type,
        subject_type=subject_type,
        subject_id=subject_id,
        state=STATE_QUEUED,
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    return job


def _load_job(session: SyncSession, job_id: str) -> Job:
    job = session.get(Job, uuid.UUID(job_id))
    if job is None:
        raise LookupError(f"job {job_id} not found")
    return job


def _publish(job: Job) -> None:
    """Best-effort (Task 2 review finding): a Redis blip here must never
    flip an already-committed state transition into a lie -- the state
    commit (in ``mark_running``/``mark_done``/``mark_failed`` above) has
    already happened by the time this runs, so a publish failure has nothing
    left to protect by propagating; it would only let the caller's outer
    exception handler (e.g. ``app.tasks.ingest.store_to_backend``'s) mistake
    an SSE hiccup for the job itself failing and overwrite ``done`` with
    ``failed``.
    """
    settings = get_settings()
    try:
        events.publish_job_event_sync(
            settings.redis_url,
            job_id=job.id,
            job_type=job.type,
            state=job.state,
            subject_type=job.subject_type,
            subject_id=job.subject_id,
        )
    except Exception:
        logger.warning("event publish failed for job %s", job.id, exc_info=True)


def mark_running(session: SyncSession, job_id: str) -> None:
    job = _load_job(session, job_id)
    job.attempts += 1
    job.state = STATE_RUNNING
    job.error = None
    session.commit()
    _publish(job)


def mark_done(session: SyncSession, job_id: str) -> None:
    job = _load_job(session, job_id)
    job.state = STATE_DONE
    job.error = None
    session.commit()
    _publish(job)


def mark_failed(session: SyncSession, job_id: str, error: str) -> None:
    """Mark a job failed -- or, if it has already run ``max_attempts`` times,
    auto-park it ``dead`` instead (Task 8: formal dead-letter state).

    ``attempts`` is incremented once per top-level run, in ``mark_running``
    above, BEFORE the run executes -- so a job that has run ``max_attempts``
    times and fails on that final attempt already has
    ``attempts == max_attempts`` by the time it lands here, and the ``>=``
    ceiling check below parks it correctly on that very call (no separate
    "attempt N+1" needed to notice the ceiling was hit).
    """
    job = _load_job(session, job_id)
    job.state = STATE_DEAD if job.attempts >= job.max_attempts else STATE_FAILED
    job.error = error
    session.commit()
    _publish(job)
