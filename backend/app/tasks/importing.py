"""``import_from_url`` Celery task (SPEC "Gallery importers"; controller
decision 3). Site-agnostic orchestration over the SiteImporter contract,
in the worker's SYNC world (app.tasks.base):

  (a) FETCHING  -> fetch_metadata + list_files; reject paid/Club/exclusive
                   (metadata.reject_reason) BEFORE any download.
  (b) DOWNLOADING-> stream EVERY file to spool (blake3 each). ALL must succeed.
  (c) create model+revision (provenance) + per-file finalize/store dispatch;
      set imports.model_id; DONE.

Any failure in (a)/(b) ⇒ FAILED, model_id NULL, ZERO orphan Model/Revision
rows (Global Constraints "IMPORTS ATOMIC"). A rejected/failed import is a
NORMAL terminal state recorded on the row -- the task swallows the exception
(after marking FAILED) rather than re-raising, so ``POST /imports`` returns
the created row and the client polls its state (in eager test mode the task
runs inline, so this also keeps POST from 500ing on an expected rejection)."""

from __future__ import annotations

import logging
from datetime import UTC, datetime

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
    events.publish_import_event_sync(get_settings().redis_url, imp.id, state.value)


@celery_app.task(name="app.tasks.importing.import_from_url")
def import_from_url(import_id: int) -> None:
    settings = get_settings()
    staged: list[download.StagedFile] = []
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
            staged.append(
                download.stream_remote_to_spool(
                    settings,
                    url=resolved.url,
                    rel_path=resolved.filename,
                    headers=resolved.headers or None,
                )
            )

        with base.sync_session() as s:
            from app.models.library import Revision

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
            logger.warning("import %s failed", import_id, exc_info=True)
        with base.sync_session() as s:
            imp = s.get(Import, import_id)
            if imp is not None:
                imp.model_id = None
                _set_state(s, imp, ImportState.FAILED, error=message)
