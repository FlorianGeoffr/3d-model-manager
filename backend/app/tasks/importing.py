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
runs inline, so this also keeps POST from 500ing on an expected rejection)."""

from __future__ import annotations

import logging
from datetime import UTC, datetime

import httpx
from sqlalchemy import delete as sa_delete

from app.config import get_settings
from app.importers import download
from app.importers.registry import IMPORTER_REGISTRY
from app.models.enums import ImportState
from app.models.system import Import
from app.services import events, library
from app.services.storage_config import resolve_backend_sync
from app.tasks import base
from app.tasks.celery_app import celery_app

logger = logging.getLogger(__name__)


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
    staged: list[download.StagedFile] = []
    created_model_id: int | None = None
    try:
        with base.sync_session() as s:
            imp = s.get(Import, import_id)
            if imp is None:
                raise LookupError(f"import {import_id} not found")
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
            backend = resolve_backend_sync(s, settings)
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
            )
            created_model_id = model.id
            rev = s.get(Revision, model.current_revision_id)
            for sf in staged:
                library.store_imported_file_sync(s, model=model, revision=rev, staged=sf)
            imp = s.get(Import, import_id)
            imp.model_id = model.id
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
                # A failure in phase (c) happened AFTER Model+Revision were
                # already committed -- delete the orphan so this stays
                # atomic (Global Constraints "IMPORTS ATOMIC"). The DB's ON
                # DELETE CASCADE (revisions.model_id, files.revision_id)
                # takes the Revision/File rows with it.
                s.execute(sa_delete(Model).where(Model.id == created_model_id))
                s.commit()
            imp = s.get(Import, import_id)
            if imp is not None:
                imp.model_id = None
                _set_state(s, imp, ImportState.FAILED, error=message)
