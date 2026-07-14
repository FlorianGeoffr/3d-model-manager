"""``app.tasks.scheduler`` (Round 10 Task 2): the single database-driven
beat dispatcher that replaced the three independent, restart-coupled
conditional beat entries for scan/sync/watch. Two layers:

* ``_due`` -- the pure(ish) arm-and-skip Redis stamp check, unit-tested in
  isolation against a real Redis (module docstring: no thundering first
  tick after a deploy/Redis-flush).
* ``dispatch_scheduled`` -- the actual celery task, run eagerly (session
  fixture, see ``tests/conftest.py``) end-to-end against a real DB-backed
  ``AppConfig`` row and real Redis stamps, asserting the same OBSERVABLE
  effects the pre-existing scan/sync/watch test suites already assert
  (a ``ScanRun``/``Job`` row created, a watched file actually processed)
  rather than mocking the three target tasks.
"""

from __future__ import annotations

import os
import time
import uuid

import pytest
from redis import Redis
from sqlalchemy import select

from app.config import get_settings
from app.models import Job, ScanRun, Setting
from app.services import jobs
from app.tasks.scheduler import DISPATCH_LOCK_KEY, _due, dispatch_scheduled
from app.tasks.slicer_watch import FAILED_DIRNAME
from app.tasks.sync_collections import schedule_sync_all

pytestmark = pytest.mark.usefixtures("library_root", "data_dir", "redis_url")

_STAMP_NAMES = ("scan", "sync", "watch")


@pytest.fixture(autouse=True)
def _clean_scheduler_redis_state(redis_url: str):
    """The Redis container is session-scoped (``tests/conftest.py``), so the
    dispatch lock and the per-feature ``tdmm:sched:last:*`` stamps -- unlike
    the Postgres tables, which ``_truncate_all_tables`` resets before every
    test -- would otherwise leak between test functions in this module.
    """

    def _flush() -> None:
        client = Redis.from_url(redis_url)
        for name in _STAMP_NAMES:
            client.delete(f"tdmm:sched:last:{name}")
        client.delete(DISPATCH_LOCK_KEY)

    _flush()
    yield
    _flush()


@pytest.fixture
def watch_dir(tmp_path, monkeypatch: pytest.MonkeyPatch):
    """Points ``WATCH_DIR`` at a fresh tmp_path, mirroring
    ``tests/test_slicer_watch.py``'s fixture of the same name."""
    watch = tmp_path / "watch"
    watch.mkdir()
    monkeypatch.setenv("WATCH_DIR", str(watch))
    get_settings.cache_clear()
    yield watch
    get_settings.cache_clear()


async def _set_app_row(db_session, **fields) -> None:
    db_session.add(Setting(key="app", value=fields))
    await db_session.commit()


# ---------------------------------------------------------------------------
# _due -- pure(ish) arm-and-skip stamp check
# ---------------------------------------------------------------------------


def test_due_missing_stamp_arms_and_returns_false(redis_url: str) -> None:
    client = Redis.from_url(redis_url)
    now = time.time()

    assert _due(client, "scan", 30, now) is False
    assert float(client.get("tdmm:sched:last:scan")) == now


def test_due_fires_once_interval_has_elapsed(redis_url: str) -> None:
    client = Redis.from_url(redis_url)
    client.set("tdmm:sched:last:scan", 1000.0)

    assert _due(client, "scan", 30, 1030.0) is True
    assert float(client.get("tdmm:sched:last:scan")) == 1030.0  # re-armed


def test_due_false_below_interval_leaves_stamp_untouched(redis_url: str) -> None:
    client = Redis.from_url(redis_url)
    client.set("tdmm:sched:last:scan", 1000.0)

    assert _due(client, "scan", 30, 1010.0) is False
    assert float(client.get("tdmm:sched:last:scan")) == 1000.0


def test_due_always_false_at_interval_zero_and_never_arms(redis_url: str) -> None:
    client = Redis.from_url(redis_url)

    assert _due(client, "scan", 0, time.time()) is False
    assert client.get("tdmm:sched:last:scan") is None


# ---------------------------------------------------------------------------
# dispatch_scheduled -- eager end-to-end
# ---------------------------------------------------------------------------


async def test_dispatch_scheduled_fires_scan_when_due(db_session, redis_url: str) -> None:
    await _set_app_row(db_session, scan_interval_s=30)
    client = Redis.from_url(redis_url)
    client.set("tdmm:sched:last:scan", time.time() - 31)

    dispatch_scheduled()

    runs = (await db_session.execute(select(ScanRun))).scalars().all()
    assert len(runs) == 1
    assert runs[0].state == "done"  # eager Celery ran scan_library inline


async def test_dispatch_scheduled_nothing_fires_when_all_intervals_zero(
    db_session, redis_url: str
) -> None:
    dispatch_scheduled()  # no "app" row at all -> every field falls back to its 0/None default

    runs = (await db_session.execute(select(ScanRun))).scalars().all()
    all_jobs = (await db_session.execute(select(Job))).scalars().all()
    assert runs == []
    assert all_jobs == []

    client = Redis.from_url(redis_url)
    for name in _STAMP_NAMES:
        assert client.get(f"tdmm:sched:last:{name}") is None  # never even armed


async def test_dispatch_scheduled_fires_sync_when_due(db_session, redis_url: str) -> None:
    await _set_app_row(db_session, collection_sync_interval_s=30)
    client = Redis.from_url(redis_url)
    client.set("tdmm:sched:last:sync", time.time() - 31)

    dispatch_scheduled()

    all_jobs = (await db_session.execute(select(Job))).scalars().all()
    assert len(all_jobs) == 1
    assert all_jobs[0].type == "sync_collections"
    assert all_jobs[0].state == jobs.STATE_DONE  # eager Celery ran sync_all inline


async def test_dispatch_scheduled_watch_fires_when_dir_set_and_due(
    db_session, redis_url: str, watch_dir
) -> None:
    await _set_app_row(db_session, watch_interval_s=30)
    stale = watch_dir / "notes.txt"  # unsupported extension -> observably moved to .failed/
    stale.write_text("just some notes")
    old = time.time() - 3600
    os.utime(stale, (old, old))

    client = Redis.from_url(redis_url)
    client.set("tdmm:sched:last:watch", time.time() - 31)

    dispatch_scheduled()

    assert not stale.exists()
    assert (watch_dir / FAILED_DIRNAME / "notes.txt").exists()


async def test_dispatch_scheduled_watch_never_fires_without_a_watch_dir(
    db_session, redis_url: str
) -> None:
    """``settings.watch_dir`` stays env-only (module docstring) -- an
    interval alone, with no dir configured, must never fire, and the
    short-circuit means the stamp is never even consulted (left exactly as
    set) rather than being armed/bumped."""
    await _set_app_row(db_session, watch_interval_s=30)
    client = Redis.from_url(redis_url)
    old_stamp = time.time() - 31
    client.set("tdmm:sched:last:watch", old_stamp)

    dispatch_scheduled()

    all_jobs = (await db_session.execute(select(Job))).scalars().all()
    assert all_jobs == []
    assert float(client.get("tdmm:sched:last:watch")) == old_stamp


async def test_dispatch_scheduled_no_ops_when_dispatch_lock_is_held(
    db_session, redis_url: str
) -> None:
    await _set_app_row(db_session, scan_interval_s=30)
    client = Redis.from_url(redis_url)
    client.set("tdmm:sched:last:scan", time.time() - 31)
    client.set(DISPATCH_LOCK_KEY, "some-other-beat-process-token")

    dispatch_scheduled()

    runs = (await db_session.execute(select(ScanRun))).scalars().all()
    assert runs == []
    # never got as far as checking `_due` -- the stamp is untouched
    assert float(client.get("tdmm:sched:last:scan")) < time.time() - 20


# ---------------------------------------------------------------------------
# schedule_sync_all's in-flight guard (Round 10 Task 2)
# ---------------------------------------------------------------------------


async def test_schedule_sync_all_skips_when_a_non_terminal_job_is_in_flight(
    db_session,
) -> None:
    running = Job(id=uuid.uuid4(), type="sync_collections", state=jobs.STATE_RUNNING)
    db_session.add(running)
    await db_session.commit()

    schedule_sync_all()

    all_jobs = (await db_session.execute(select(Job))).scalars().all()
    assert len(all_jobs) == 1  # no new job created -- the in-flight one blocks it
    assert all_jobs[0].id == running.id
    assert all_jobs[0].state == jobs.STATE_RUNNING  # untouched


async def test_schedule_sync_all_creates_a_job_when_only_terminal_jobs_exist(
    db_session,
) -> None:
    done = Job(id=uuid.uuid4(), type="sync_collections", state=jobs.STATE_DONE)
    db_session.add(done)
    await db_session.commit()

    schedule_sync_all()

    all_jobs = (await db_session.execute(select(Job))).scalars().all()
    assert len(all_jobs) == 2
    new_job = next(j for j in all_jobs if j.id != done.id)
    assert new_job.type == "sync_collections"
    assert new_job.state == jobs.STATE_DONE  # eager Celery ran sync_all inline too
