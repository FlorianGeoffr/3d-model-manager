"""The Celery application (SPEC "Processing pipeline"; Task 6 interface
decisions).

Broker + result backend are both ``TDMM_REDIS_URL``. ``task_acks_late=True``
so a worker that dies mid-task redelivers the message rather than losing it.
Queue ``io`` carries M1's ``store_to_backend`` plus everything else under
``app.tasks``; ``cpu`` (memory-recycled worker pool, per SPEC "Architecture")
is routed by name ahead of time for the CPU-heavy extraction/render tasks
``app.tasks.pipeline`` registers -- Task 2 adds the driver/runner but no real
step bodies yet, so nothing dispatches to ``cpu`` in practice until Tasks 3-6
land.

Worker entrypoint: ``celery -A app.tasks.celery_app worker``.

Tests never hit the broker at all: a session-scoped autouse fixture
(``tests/conftest.py::_celery_eager_mode``) flips ``task_always_eager`` on
this same module-level ``celery_app`` object before any test runs, so
``.delay()``/``.apply_async()`` just run the task body inline.
"""

from celery import Celery
from kombu import Queue

from app.config import get_settings

_settings = get_settings()

celery_app = Celery("tdmm", broker=_settings.redis_url, backend=_settings.redis_url)

celery_app.conf.update(
    task_acks_late=True,
    task_default_queue="io",
    task_queues=(Queue("io"), Queue("cpu")),
    # Dict order matters: Celery's router checks patterns in insertion order
    # and takes the first match, so the more specific `pipeline.*` entry
    # (M2's CPU-heavy extraction/render tasks) must come before the general
    # `app.tasks.*` catch-all or every task -- pipeline included -- would
    # always match the catch-all first and land on `io`.
    task_routes={
        "app.tasks.pipeline.*": {"queue": "cpu"},
        "app.tasks.*": {"queue": "io"},
    },
    imports=(
        "app.tasks.ingest",
        "app.tasks.pipeline",
        "app.tasks.scan",
        "app.tasks.migrate",
        "app.tasks.relocate",
        "app.tasks.printing",
        "app.tasks.importing",
        "app.tasks.sync_collections",
        "app.tasks.slicer_watch",
    ),
)

# Scheduled work is entirely OPT-IN: each entry appears only when its interval
# setting is a positive number of seconds. Built additively (rather than
# assigning `beat_schedule` per feature) so enabling one never clobbers another.
# Both point at a `schedule_*` wrapper rather than the real task, since each
# needs a tracking row (ScanRun / Job) that some caller normally creates.
_beat_schedule: dict[str, dict] = {}

# SPEC "optional scheduled scan" (Task 5 brief) -- TDMM_SCAN_INTERVAL_S.
if _settings.scan_interval_s > 0:
    _beat_schedule["scan-library"] = {
        "task": "app.tasks.scan.schedule_scan_library",
        "schedule": _settings.scan_interval_s,
    }

# M8 H periodic collection sync -- TDMM_COLLECTION_SYNC_INTERVAL_S.
if _settings.collection_sync_interval_s > 0:
    _beat_schedule["sync-collections"] = {
        "task": "app.tasks.sync_collections.schedule_sync_all",
        "schedule": _settings.collection_sync_interval_s,
    }

# Round 8 Task 5 (watched-folder auto-import) -- TDMM_SLICER_WATCH_INTERVAL_S,
# gated on TDMM_SLICER_WATCH_DIR also being set (an interval alone with no
# watch dir configured would just no-op every tick). No `schedule_*` wrapper
# needed here, unlike scan/collection-sync above -- this task doesn't need a
# tracking row created ahead of time, it just walks the directory itself.
if _settings.slicer_watch_interval_s > 0 and _settings.slicer_watch_dir is not None:
    _beat_schedule["slicer-watch"] = {
        "task": "app.tasks.slicer_watch.scan_slicer_watch",
        "schedule": _settings.slicer_watch_interval_s,
    }

if _beat_schedule:
    celery_app.conf.beat_schedule = _beat_schedule
