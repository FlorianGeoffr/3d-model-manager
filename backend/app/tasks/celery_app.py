"""The Celery application (SPEC "Processing pipeline"; Task 6 interface
decisions).

Broker + result backend are both ``TDMM_REDIS_URL``. ``task_acks_late=True``
so a worker that dies mid-task redelivers the message rather than losing it.
Queue ``io`` is the only one used in M1 (``store_to_backend``); ``cpu`` is
declared now (memory-recycled worker pool, per SPEC "Architecture") for the
CPU-heavy extraction/render tasks M2 adds -- no M1 task routes there yet.

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
    task_routes={"app.tasks.*": {"queue": "io"}},
    imports=("app.tasks.ingest",),
)
