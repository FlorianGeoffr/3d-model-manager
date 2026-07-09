"""``import_from_url`` Celery task (SPEC "Gallery importers"; controller
decision 3). Site-agnostic orchestration over the SiteImporter contract,
in the worker's SYNC world (app.tasks.base):

  (a) FETCHING  -> fetch_metadata + list_files; reject paid/Club/exclusive
                   (metadata.reject_reason) BEFORE any download.
  (b) DOWNLOADING-> stream EVERY file to spool (blake3 each). ALL must succeed.
  (c) create model+revision (provenance) + per-file finalize/store dispatch;
      set imports.model_id; DONE.

Any failure in (a), (b), OR (c) ⇒ FAILED, model_id NULL, ZERO orphan
Model/Revision/File rows (Global Constraints "IMPORTS ATOMIC"): a failure
partway through (c) -- after Model+Revision are already committed -- deletes
the just-created model (the DB's ON DELETE CASCADE takes its Revision/File
rows with it) rather than leaving it orphaned. A rejected/failed import is a
NORMAL terminal state recorded on the row -- the task swallows the exception
(after marking FAILED) rather than re-raising, so ``POST /imports`` returns
the created row and the client polls its state (in eager test mode the task
runs inline, so this also keeps POST from 500ing on an expected rejection).

**M6 Task 4 (B1) -- re-entry idempotency under `task_acks_late` redelivery:**
a worker hard-killed (SIGKILL/OOM) mid-import never runs the `except` below;
Celery redelivers the same message and a naive reprocess-from-scratch would
create a SECOND model, and -- if the crash landed after phase (c)'s model
commit but before `DONE` -- orphan the first one behind a row stuck
`downloading` forever. Two mechanisms close this (mirrors `app.tasks.scan`'s
singleton lock):

1. A per-import Redis lock (``import_lock_key``) makes a genuinely
   concurrent redelivery (the original attempt still in-flight) a clean
   no-op -- the losing side returns immediately without touching the row.
2. `imp.model_id` is linked immediately after the model is created in
   phase (c) (rather than after the whole per-file store loop), AND in the
   SAME commit as the Model+Revision insert (``create_imported_model_sync``
   is called with ``commit=False`` for exactly this) -- so there is no
   window where a Model is durably committed while the link is not. A crash
   from that point on leaves a *detectable* orphan: the model exists, is
   linked from the import row, but the row's state never reached `DONE`. The
   task's entry guard reconciles against this on every run -- a terminal
   (`DONE`/`FAILED`) row is a no-op (nothing to redo), while a non-terminal
   row with `model_id` already set is exactly that partial-commit crash:
   delete the orphan model (cascade takes its Revision/File rows) and
   reprocess fresh. A crash BEFORE that single commit leaves nothing at all
   (the flushed-but-uncommitted Model/Revision are discarded when the
   session closes without committing). This still upholds the "ZERO
   orphans" invariant above: the same-execution failure handler's orphan
   delete relies on ``imports.model_id``'s ``ON DELETE SET NULL`` to null
   the link as part of that same statement, whether the early link had
   already committed or not."""

from __future__ import annotations

import contextlib
import logging
from datetime import UTC, datetime

import httpx
from redis import Redis
from sqlalchemy import delete as sa_delete

from app.config import get_settings
from app.importers import download
from app.importers.registry import IMPORTER_REGISTRY
from app.models.enums import ImportState
from app.models.system import Import
from app.services import events, library
from app.services.storage_backends import resolve_default_backend_sync
from app.tasks import base
from app.tasks.celery_app import celery_app

logger = logging.getLogger(__name__)

# Per-import singleton lock (mirrors `app.tasks.scan.SCAN_LOCK_KEY`): guards
# against a genuinely concurrent redelivery racing the still-in-flight
# original attempt. 1800s comfortably exceeds a realistic import (metadata
# fetch + N file downloads + store) -- if a worker is legitimately still
# running past that, the lock expiring just re-opens the door to the same
# entry-guard reconciliation below, not a silent double-run.
IMPORT_LOCK_TIMEOUT_S = 1800


def import_lock_key(import_id: int) -> str:
    return f"tdmm:import:{import_id}:lock"


class ImportRejected(Exception):
    """Un-importable model (paid/Club/exclusive, or no files) -- recorded as
    a clean FAILED with a human message, never a crash."""


def _set_state(session, imp: Import, state: ImportState, *, error: str | None = None) -> None:
    imp.state = state
    if error is not None:
        imp.error = error
    session.commit()
    # Best-effort publish (Task 3 review finding, mirrors app.services.jobs's
    # `_publish`): a Redis blip here must never revert the state change just
    # committed above -- on the DONE path that would orphan an already-created
    # model behind a misleading FAILED row, and on the FAILED path it would
    # re-raise out of the task entirely (a 500 on the eager POST path).
    try:
        events.publish_import_event_sync(get_settings().redis_url, imp.id, state.value)
    except Exception as exc:  # noqa: BLE001 -- publish failures are logged, never propagated
        logger.warning("import event publish failed: %s", type(exc).__name__)


@celery_app.task(name="app.tasks.importing.import_from_url")
def import_from_url(import_id: int) -> None:
    from app.models.library import Model, Revision

    settings = get_settings()
    client = Redis.from_url(settings.redis_url)
    lock = client.lock(import_lock_key(import_id), timeout=IMPORT_LOCK_TIMEOUT_S, blocking=False)
    if not lock.acquire(blocking=False):
        # Another attempt (a genuinely concurrent redelivery) is already
        # inside this import -- no-op rather than racing its fetch/
        # download/store phases (mirrors scan.py's singleton lock).
        logger.info("import %s already being processed (lock held); redelivery ignored", import_id)
        return

    staged: list[download.StagedFile] = []
    created_model_id: int | None = None
    try:
        with base.sync_session() as s:
            imp = s.get(Import, import_id)
            if imp is None:
                raise LookupError(f"import {import_id} not found")
            if imp.state in (ImportState.DONE, ImportState.FAILED):
                # Redelivery of an already-terminal run -- nothing to redo.
                return
            if imp.model_id is not None:
                # A prior attempt committed a model (the early link in phase
                # (c) below) but died before reaching DONE -- delete that
                # orphan (DB CASCADE takes its Revision/File rows with it)
                # and reprocess fresh rather than duplicate it.
                s.execute(sa_delete(Model).where(Model.id == imp.model_id))
                imp.model_id = None
                s.commit()
            importer = IMPORTER_REGISTRY.get(imp.site)
            if importer is None:
                raise ImportRejected(f"no importer registered for {imp.site}")
            external_id = imp.external_id or ""
            _set_state(s, imp, ImportState.FETCHING)

        meta = importer.fetch_metadata(external_id)
        if meta.reject_reason:
            raise ImportRejected(meta.reject_reason)
        files = importer.list_files(external_id)
        if not files:
            raise ImportRejected("no downloadable files found for this model")

        with base.sync_session() as s:
            imp = s.get(Import, import_id)
            _set_state(s, imp, ImportState.DOWNLOADING)

        for f in files:
            resolved = importer.resolve_download(external_id, f)
            try:
                staged.append(
                    download.stream_remote_to_spool(
                        settings,
                        url=resolved.url,
                        rel_path=resolved.filename,
                        headers=resolved.headers or None,
                    )
                )
            except (httpx.HTTPStatusError, httpx.RequestError) as exc:
                # `exc`'s own str() echoes the URL it hit -- for a real
                # importer that's a signed/short-TTL download URL that can
                # carry a token or access code (e.g. Thingiverse's
                # Authorization-bearer-style download links). Re-raise a
                # sanitized domain error naming only the filename + status
                # BEFORE it can reach `imports.error` or a log line; `from
                # None` also drops the original exception from this new
                # one's traceback chain, so exc_info on it can't echo the
                # URL back either.
                status = getattr(getattr(exc, "response", None), "status_code", None)
                detail = f"HTTP {status}" if status is not None else type(exc).__name__
                raise RuntimeError(
                    f"download failed for {resolved.filename!r} ({detail})"
                ) from None

        with base.sync_session() as s:
            # Workstream C task C2: the model directory + sidecar (this is
            # the only DIRECT storage write in this task -- every imported
            # file's own bytes are written by the shared `store_to_backend`
            # task below, which resolves + stamps the default backend for
            # each File itself) always lands on the DEFAULT backend.
            backend, _default_backend_id = resolve_default_backend_sync(s, settings)
            model = library.create_imported_model_sync(
                s,
                backend,
                name=meta.title,
                description=meta.description,
                source_url=meta.source_url,
                source_site=meta.site.value,
                source_author=meta.author,
                source_license=meta.license,
                imported_at=datetime.now(UTC),
                tags=list(meta.tags),
                initial_revision_name="imported",
                commit=False,
            )
            created_model_id = model.id
            imp = s.get(Import, import_id)
            # LINK EARLY, SAME TRANSACTION: `commit=False` above left Model+
            # Revision flushed-but-uncommitted -- this single commit persists
            # them together with `imp.model_id`, so there is no window where
            # the model is durably committed while the link is not. A crash
            # from here on leaves a DETECTABLE orphan (entry guard above); a
            # crash before this commit leaves NOTHING (the flush is rolled
            # back when the session closes without committing).
            imp.model_id = model.id
            s.commit()
            rev = s.get(Revision, model.current_revision_id)
            for sf in staged:
                library.store_imported_file_sync(s, model=model, revision=rev, staged=sf)
            imp = s.get(Import, import_id)
            imp.meta = {
                "cover_url": meta.cover_url,
                "license": meta.license,
                "files": [sf.rel_path for sf in staged],
            }
            _set_state(s, imp, ImportState.DONE)
    except Exception as exc:  # noqa: BLE001 -- failure is a recorded terminal state, not a crash
        for sf in staged:
            sf.spool_path.unlink(missing_ok=True)
        message = str(exc) if isinstance(exc, ImportRejected) else f"import failed: {exc}"
        if not isinstance(exc, ImportRejected):
            # `message` is safe to log by this point -- the one exception
            # type whose str() could carry a URL (the download try/except
            # above) is intercepted before it ever gets here. Logged as
            # type + message (never `exc_info=True`) as defense in depth,
            # mirroring app.printerd/app.tasks.printing's type-only scrub.
            logger.warning("import %s failed: %s: %s", import_id, type(exc).__name__, message)
        with base.sync_session() as s:
            if created_model_id is not None:
                # A failure in phase (c) happened AFTER Model+Revision (and,
                # since the M6 Task 4 early link, possibly `imports.model_id`
                # itself) were already committed -- delete the orphan so this
                # stays atomic (Global Constraints "IMPORTS ATOMIC"). The
                # DB's ON DELETE CASCADE (revisions.model_id, files.
                # revision_id) takes the Revision/File rows with it, and
                # `imports.model_id`'s own ON DELETE SET NULL nulls the link
                # as part of the same statement if it had already committed.
                s.execute(sa_delete(Model).where(Model.id == created_model_id))
                s.commit()
            imp = s.get(Import, import_id)
            if imp is not None:
                # Idempotent even when the delete above already nulled this
                # via the FK's ON DELETE SET NULL (or when no model was ever
                # created this run) -- either way `imports.model_id` must be
                # NULL on a FAILED row.
                imp.model_id = None
                _set_state(s, imp, ImportState.FAILED, error=message)
    finally:
        with contextlib.suppress(Exception):
            lock.release()
