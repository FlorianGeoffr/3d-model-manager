"""``store_to_backend`` Celery task (SPEC "Processing pipeline", Task 6
interface decisions): streams the upload's spool file onto the storage
backend, verifies the blake3 hash the backend computed while writing
matches the blob's hash, marks the file verified, and drops the spool file.

Before marking anything verified, it also re-checks that the ``File`` row is
still there and still points at the blob it started with -- a belt-and-
suspenders guard alongside ``app.services.library``'s own 409s for the case
where a ``replace=true`` re-upload deleted/repointed the row while this
job's ``backend.write`` was in flight.

Runs entirely in the worker's SYNC world -- see ``app.tasks.base`` for why
this can't share the API's async engine.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

from app.config import get_settings
from app.models import File, FileLocation
from app.services import jobs
from app.services.storage_backends import resolve_default_backend_sync
from app.tasks import base, pipeline
from app.tasks.celery_app import celery_app

logger = logging.getLogger(__name__)

_CHUNK_SIZE = 1024 * 1024  # 1 MiB, matching StorageBackend.read's chunking.


def _spool_chunks(path: Path) -> Iterator[bytes]:
    with path.open("rb") as fh:
        while True:
            chunk = fh.read(_CHUNK_SIZE)
            if not chunk:
                break
            yield chunk


@celery_app.task
def store_to_backend(job_id: str, file_id: int, spool_path: str) -> None:
    settings = get_settings()
    with base.sync_session() as session:
        # Workstream C task C2: new writes always land on the DEFAULT
        # backend (reads later resolve per-file via `files.backend_id`,
        # which this task stamps below once the write verifies).
        backend, default_backend_id = resolve_default_backend_sync(session, settings)
    path = Path(spool_path)

    try:
        # ``mark_running`` (state commit + Redis publish) lives INSIDE this
        # try (Task 6 review finding): it used to run before the try block,
        # so a transient failure here (e.g. the events publish) left the job
        # stuck in queued/running forever with no retry path -- ``retry_job``
        # only accepts ``failed`` jobs. Routing it through the same
        # except-clause below gives it the normal mark_failed/retry path.
        with base.sync_session() as session:
            jobs.mark_running(session, job_id)

        with base.sync_session() as session:
            file = session.get(File, file_id)
            if file is None:
                raise LookupError(f"file {file_id} not found")
            storage_path = file.storage_path
            expected_hash = file.blob_hash

        result = backend.write(storage_path, _spool_chunks(path))

        if result.hash != expected_hash:
            with base.sync_session() as session:
                jobs.mark_failed(
                    session,
                    job_id,
                    f"hash mismatch: expected {expected_hash}, got {result.hash}",
                )
            return  # Spool intentionally kept on disk for retry/debug.

        with base.sync_session() as session:
            file = session.get(File, file_id)
            if file is None or file.blob_hash != expected_hash:
                # This file's row was superseded while `backend.write` above
                # was running: a `replace=true` re-upload for the same
                # rel_path deleted this row (new id, own job) and/or a
                # different upload repointed a row at a new blob before we
                # got here. The bytes we just wrote may already be stale, so
                # marking anything verified now would let a losing write
                # silently win the race. There's also nothing left for this
                # job to usefully retry -- the row it was writing for is gone
                # or has moved on -- so `failed` (not `done`) is the correct
                # terminal state; the spool file is deliberately left on disk
                # (same as the hash-mismatch path above) in case a human
                # wants to inspect it.
                jobs.mark_failed(
                    session, job_id, "file was superseded by a replacement upload; store aborted"
                )
                return
            now = datetime.now(UTC)
            file.mtime = now
            file.verified_at = now
            file.backend_id = default_backend_id
            # Get-or-create (upsert-safe): a retry of this same job re-runs
            # the whole write, so a location row from an earlier attempt may
            # already exist for this (file_id, backend_id) pair.
            location = session.get(FileLocation, (file.id, default_backend_id))
            if location is None:
                session.add(
                    FileLocation(file_id=file.id, backend_id=default_backend_id, verified_at=now)
                )
            else:
                location.verified_at = now
            session.commit()
            jobs.mark_done(session, job_id)
            # Kick off this blob's processing pipeline (Task 2). A blob
            # shared by more than one File (dedup) can have this called once
            # per File that uploads it -- self-healing via retry rather than
            # strictly harmless (whole-branch review, Important #3): two
            # concurrent runs for the same (blob_hash, kind) can still race
            # each other (get-or-create INSERT race; a losing run's late
            # failure landing after a winner's `ok`), but `upsert_derivative`/
            # `mark_derivative` (app.services.derivatives) now survive the
            # former and refuse to downgrade the latter, and each pipeline
            # step still checks whether its derivative output is already `ok`
            # before doing any work, marking itself done as a no-op skip if
            # so.
            pipeline.start_pipeline_sync(session, blob_hash=expected_hash, file_id=file_id)
    except Exception as exc:
        with base.sync_session() as session:
            jobs.mark_failed(session, job_id, str(exc))
        # Spool intentionally left on disk for retry/debug.
        raise

    # Cleanup is best-effort and isolated in its own try/except (Task 6
    # review finding): it used to sit inside the try above, so a failure
    # here (e.g. the spool file vanishing out-of-band) would be caught by
    # the `except Exception` and overwrite the already-committed `done`
    # job/file state back to `failed`, leaving retry semantics incoherent
    # (retry would re-run a job whose file is already verified). A stray
    # spool file left behind after a successful store is just disk space,
    # not a correctness problem, so this only logs.
    try:
        path.unlink(missing_ok=True)
    except Exception:
        logger.warning("failed to remove spool file %s after successful store", path, exc_info=True)
