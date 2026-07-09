"""Periodic sync of the user's followed remote collections (M8 H).

Walks every ``followed_collections`` row, lists that remote list's items, and
for each item that is NOT already in the library
(``app.services.import_dedup``) either:

* ``mode="auto"``   -> creates an ``Import`` row and dispatches the normal
  ``import_from_url`` pipeline, or
* ``mode="review"`` -> parks it in ``pending_imports`` for one-click approval.

Re-walking a list is naturally idempotent: item identity is
``(site, external_id)``, the dedup guard answers "already imported?", and
``add_pending_sync`` is a no-op for an already-queued item. An item that has
since landed in the library is also un-queued, so a stale review row can't
linger forever.

One failing site/list is recorded on THAT row's ``last_error`` and never sinks
the rest of the run. Runs entirely in the worker's SYNC world -- see
``app.tasks.base``.
"""

from __future__ import annotations

import logging
import uuid

from app.importers.base import SEARCH_PAGE_SIZE
from app.importers.registry import get_importer
from app.models.collections import FollowedCollection
from app.models.enums import CollectionSyncMode, ImportState
from app.models.system import Import
from app.services import collections as collections_svc
from app.services import jobs
from app.services.import_dedup import find_live_import_sync
from app.tasks import base
from app.tasks.celery_app import celery_app
from app.tasks.importing import import_from_url

logger = logging.getLogger(__name__)

# A followed list is walked page-by-page; this bounds a pathological/looping
# upstream rather than trusting it to eventually return a short page.
MAX_PAGES = 20


def _walk_list_items(importer, list_id: str):
    """Yield every item of a remote list, page by page, stopping on the first
    short (or empty) page."""
    for page in range(1, MAX_PAGES + 1):
        items = importer.list_list_items(list_id, page)
        yield from items
        if len(items) < SEARCH_PAGE_SIZE:
            return


def _sync_one(session, collection: FollowedCollection) -> None:
    importer = get_importer(collection.site)
    if importer is None:
        collections_svc.mark_synced_sync(
            session, collection, error=f"{collection.site.value} isn't available"
        )
        return

    for item in _walk_list_items(importer, collection.list_id):
        if find_live_import_sync(session, item.site, item.external_id) is not None:
            # Already in the library: make sure it isn't still sitting in the
            # review queue from an earlier run.
            collections_svc.drop_pending_sync(session, collection, item.external_id)
            continue

        if collection.mode == CollectionSyncMode.AUTO:
            imp = Import(
                url=item.url,
                site=item.site,
                external_id=item.external_id,
                state=ImportState.PENDING,
            )
            session.add(imp)
            session.commit()
            session.refresh(imp)
            import_from_url.apply_async(args=[imp.id], task_id=f"import-{imp.id}")
        else:
            collections_svc.add_pending_sync(
                session,
                collection,
                external_id=item.external_id,
                title=item.title,
                url=item.url,
                thumbnail_url=item.thumbnail_url,
            )

    collections_svc.mark_synced_sync(session, collection, error=None)


@celery_app.task(name="app.tasks.sync_collections.sync_all")
def sync_all(job_id: str) -> None:
    with base.sync_session() as s:
        jobs.mark_running(s, job_id)

    try:
        with base.sync_session() as s:
            collection_ids = [c.id for c in collections_svc.list_followed_sync(s)]

        for collection_id in collection_ids:
            with base.sync_session() as s:
                collection = s.get(FollowedCollection, collection_id)
                if collection is None:
                    continue  # unfollowed while this run was in flight
                try:
                    _sync_one(s, collection)
                except Exception as exc:  # noqa: BLE001 -- one list must not sink the run
                    logger.warning(
                        "collection sync %s failed for %s/%s",
                        job_id,
                        collection.site.value,
                        collection.list_id,
                        exc_info=True,
                    )
                    collections_svc.mark_synced_sync(s, collection, error=str(exc))
    except Exception as exc:
        with base.sync_session() as s:
            jobs.mark_failed(s, job_id, str(exc))
        raise

    # Mark done in its own try (same posture as migrate/relocate): every list's
    # own outcome is already durably recorded, so a hiccup here must not
    # misreport a genuinely-successful run as failed.
    try:
        with base.sync_session() as s:
            jobs.mark_done(s, job_id)
    except Exception:
        logger.warning(
            "collection sync %s: succeeded but marking done failed", job_id, exc_info=True
        )


@celery_app.task(name="app.tasks.sync_collections.schedule_sync_all")
def schedule_sync_all() -> None:
    """Beat-only entrypoint (opt-in, gated on ``settings.collection_sync_interval_s``
    -- see ``app.tasks.celery_app``). ``sync_all`` always operates against a Job
    row some caller created, so a scheduled tick creates its own first (mirrors
    ``app.tasks.scan.schedule_scan_library``)."""
    with base.sync_session() as s:
        job = jobs.create_job_sync(
            s, id=uuid.uuid4(), type="sync_collections", subject_type=None, subject_id=None
        )
        job_id = str(job.id)
    sync_all.apply_async(args=[job_id], task_id=job_id)
