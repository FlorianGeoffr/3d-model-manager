"""The ``scan_library`` Celery task (SPEC "Rescan/reconcile"; Task 5 brief).

A Redis singleton lock (``tdmm:scan:lock``) keeps two scans from ever
running concurrently -- a losing task marks its own ``ScanRun`` ``skipped``
rather than blocking, since the API's own ``POST /api/scan`` 409s ahead of
time on any ``queued``/``running`` row; the lock is the last-line defense
against a race (two nearly-simultaneous POSTs) or a manually-dispatched task.
"""

from __future__ import annotations

import contextlib

from redis import Redis
from sqlalchemy import select

from app.config import get_settings
from app.models import ScanRun
from app.services import scanner
from app.services.events import publish_scan_event_sync
from app.services.storage_config import resolve_backend_sync
from app.tasks import base
from app.tasks.celery_app import celery_app

_LOCK_KEY = "tdmm:scan:lock"
_LOCK_TIMEOUT_S = 3600


@celery_app.task(name="app.tasks.scan.scan_library")
def scan_library(scan_run_id: int) -> None:
    settings = get_settings()
    client = Redis.from_url(settings.redis_url)
    lock = client.lock(_LOCK_KEY, timeout=_LOCK_TIMEOUT_S, blocking=False)
    if not lock.acquire(blocking=False):
        with base.sync_session() as s:
            scanner.mark_scan_state(s, scan_run_id, "skipped")  # another run holds the lock
        return
    try:
        with base.sync_session() as s:
            scanner.mark_scan_state(s, scan_run_id, "running")
            publish_scan_event_sync(settings.redis_url, scan_run_id, "running")
            backend = resolve_backend_sync(s, settings)
            scanner.run_scan(s, settings, backend, scan_run_id)  # sets state=done, finished_at
            publish_scan_event_sync(settings.redis_url, scan_run_id, "done")
    except Exception:
        with base.sync_session() as s:
            scanner.mark_scan_state(s, scan_run_id, "failed")
            publish_scan_event_sync(settings.redis_url, scan_run_id, "failed")
        raise
    finally:
        with contextlib.suppress(Exception):
            lock.release()


@celery_app.task(name="app.tasks.scan.schedule_scan_library")
def schedule_scan_library() -> None:
    """Beat-only entrypoint (opt-in, see ``app.tasks.celery_app``'s
    conditional ``beat_schedule``): ``scan_library`` itself always operates
    against a ``scan_run_id`` some caller already created (the API's
    ``POST /api/scan``, normally), so a scheduled tick needs its own small
    wrapper to create that row first. Skips the tick entirely (no new row,
    no dispatch) if a scan is already ``queued``/``running`` -- mirrors
    ``POST /api/scan``'s 409 guard, just silent since there's no HTTP caller
    to report a conflict to.
    """
    with base.sync_session() as s:
        in_flight = s.execute(
            select(ScanRun.id).where(ScanRun.state.in_(("queued", "running")))
        ).scalar_one_or_none()
        if in_flight is not None:
            return
        scan_run = ScanRun(state="queued")
        s.add(scan_run)
        s.commit()
        s.refresh(scan_run)
        scan_run_id = scan_run.id

    scan_library.apply_async(args=[scan_run_id])
