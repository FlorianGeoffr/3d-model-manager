"""Background job tracking (SPEC ``jobs``; "Processing pipeline": "every
task tracked in jobs", Task 6 interface decisions).

Split by execution context, matching the API(async)/worker(sync) boundary
documented in ``app.tasks.base``:

- ``create_job``, ``list_jobs``, ``get_job_or_404``, ``retry_job`` run on the
  API's async engine (called from ``app.api.uploads``/``app.api.jobs``).
- ``mark_running``, ``mark_done``, ``mark_failed`` run on the worker's sync
  engine, called from inside ``app.tasks.ingest.store_to_backend``.

Each transition helper also publishes the SSE ``job.updated`` event (see
``app.services.events``) to ``tdmm:events``.
"""

from __future__ import annotations

import uuid

import anyio
from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session as SyncSession

from app.config import Settings, get_settings
from app.models import Job
from app.services import events
from app.services import spool as spool_service

STATE_QUEUED = "queued"
STATE_RUNNING = "running"
STATE_DONE = "done"
STATE_FAILED = "failed"


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
    """Re-enqueue ``store_to_backend`` for a ``failed`` job whose spool file
    is still on disk (Task 6 interface decision). 409 if the job isn't
    ``failed``, or its spool file is gone. ``attempts`` is left untouched
    here -- the task itself increments it on every run, so it's naturally
    "preserved" (i.e. keeps growing) across retries.
    """
    # Local import: app.tasks.ingest imports app.services.jobs (for the
    # mark_* helpers), so importing it back at module level here would be a
    # circular import. Delaying it to call time breaks the cycle.
    from app.tasks.ingest import store_to_backend

    job = await get_job_or_404(db, job_id)
    if job.state != STATE_FAILED:
        raise HTTPException(status.HTTP_409_CONFLICT, f"job {job_id} is not in a failed state")

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

    store_to_backend.apply_async(args=[str(job.id), job.subject_id, str(path)], task_id=str(job.id))

    await db.refresh(job)
    return job


# -- sync: worker-side (see app.tasks.base) --------------------------------


def _load_job(session: SyncSession, job_id: str) -> Job:
    job = session.get(Job, uuid.UUID(job_id))
    if job is None:
        raise LookupError(f"job {job_id} not found")
    return job


def _publish(job: Job) -> None:
    settings = get_settings()
    events.publish_job_event_sync(
        settings.redis_url,
        job_id=job.id,
        job_type=job.type,
        state=job.state,
        subject_type=job.subject_type,
        subject_id=job.subject_id,
    )


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
    job = _load_job(session, job_id)
    job.state = STATE_FAILED
    job.error = error
    session.commit()
    _publish(job)
