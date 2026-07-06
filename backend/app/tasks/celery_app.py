"""The Celery application (SPEC "Processing pipeline"; Task 6 interface
decisions).

Broker + result backend are both ``TDMM_REDIS_URL``. ``task_acks_late=True``
so a worker that dies mid-task redelivers the message rather than losing it.
Queue ``io`` carries M1's ``store_to_backend`` plus everything else under
``app.tasks``; ``cpu`` (memory-recycled worker pool, per SPEC "Architecture")
is routed by name ahead of time for the CPU-heavy extraction/render tasks
``app.tasks.pipeline`` adds starting Task 2 -- that module doesn't exist yet
at this commit, so nothing dispatches to ``cpu`` in practice until then.

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
    imports=("app.tasks.ingest",),
)
