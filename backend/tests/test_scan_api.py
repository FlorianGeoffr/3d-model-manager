"""``POST /api/scan`` / ``GET /api/scan-runs[/{id}]`` (SPEC "Rescan/
reconcile"; Task 5 brief). Celery runs eager in tests, so a ``POST``
completes the whole scan inline before the response is returned.
"""

from __future__ import annotations

import httpx
import pytest
import redis.asyncio as aioredis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ScanRun

pytestmark = pytest.mark.usefixtures("library_root")

# Mirrors `app.tasks.scan`'s Redis singleton lock key -- kept as a literal
# here (rather than imported) so these tests exercise the real key name the
# implementation must use, not whatever name a refactor happens to pick.
_SCAN_LOCK_KEY = "tdmm:scan:lock"


async def test_post_scan_creates_and_runs_to_done(
    authenticated_client: httpx.AsyncClient,
) -> None:
    response = await authenticated_client.post("/api/scan")

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["state"] == "done"
    assert body["finished_at"] is not None
    assert body["files_seen"] == 0
    assert body["files_hashed"] == 0
    assert body["relinked"] == 0
    assert body["adopted"] == 0
    assert body["missing"] == 0
    assert body["report"] == {
        "adopted": [],
        "relinked": [],
        "changed": [],
        "missing": [],
        "errors": [],
        "verified": 0,
    }


async def test_post_scan_conflicts_with_running_scan(
    authenticated_client: httpx.AsyncClient, db_session: AsyncSession, redis_url: str
) -> None:
    """A `running` ScanRun only conflicts a new scan while its worker is
    genuinely still alive -- modeled here by holding the same Redis
    singleton lock `scan_library` itself acquires for the run's duration
    (Task 5 fix-wave Finding 2: a `running` row with no held lock is
    stale/reclaimable instead, see
    `test_post_scan_reclaims_stale_running_scan_when_lock_not_held` below).
    """
    client = aioredis.Redis.from_url(redis_url)
    await client.set(_SCAN_LOCK_KEY, "some-other-worker-token")
    try:
        db_session.add(ScanRun(state="running"))
        await db_session.commit()

        response = await authenticated_client.post("/api/scan")

        assert response.status_code == 409
    finally:
        await client.delete(_SCAN_LOCK_KEY)
        await client.aclose()


async def test_post_scan_reclaims_stale_running_scan_when_lock_not_held(
    authenticated_client: httpx.AsyncClient, db_session: AsyncSession, redis_url: str
) -> None:
    """Task 5 fix-wave Finding 2: a hard-killed worker (SIGKILL/OOM) never
    reaches `scan_library`'s cleanup, leaving `state="running"` forever with
    nothing holding the scan lock. `POST /api/scan` must reclaim it (mark it
    `failed`) instead of 409ing every future scan forever.
    """
    stale = ScanRun(state="running")
    db_session.add(stale)
    await db_session.commit()
    await db_session.refresh(stale)
    stale_id = stale.id

    response = await authenticated_client.post("/api/scan")

    assert response.status_code == 201, response.text
    assert response.json()["id"] != stale_id

    await db_session.refresh(stale)
    assert stale.state == "failed"
    assert stale.finished_at is not None
    assert stale.report is not None
    assert "error" in stale.report


async def test_post_scan_conflicts_with_queued_scan(
    authenticated_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    db_session.add(ScanRun(state="queued"))
    await db_session.commit()

    response = await authenticated_client.post("/api/scan")

    assert response.status_code == 409


async def test_list_scan_runs_most_recent_first(
    authenticated_client: httpx.AsyncClient,
) -> None:
    first = await authenticated_client.post("/api/scan")
    second = await authenticated_client.post("/api/scan")
    assert first.status_code == 201
    assert second.status_code == 201

    response = await authenticated_client.get("/api/scan-runs")

    assert response.status_code == 200
    ids = [row["id"] for row in response.json()]
    assert ids.index(second.json()["id"]) < ids.index(first.json()["id"])


async def test_list_scan_runs_respects_limit(authenticated_client: httpx.AsyncClient) -> None:
    for _ in range(3):
        assert (await authenticated_client.post("/api/scan")).status_code == 201

    response = await authenticated_client.get("/api/scan-runs", params={"limit": 2})

    assert response.status_code == 200
    assert len(response.json()) == 2


async def test_get_scan_run_by_id(authenticated_client: httpx.AsyncClient) -> None:
    created = await authenticated_client.post("/api/scan")

    response = await authenticated_client.get(f"/api/scan-runs/{created.json()['id']}")

    assert response.status_code == 200
    assert response.json()["id"] == created.json()["id"]


async def test_get_scan_run_unknown_id_is_404(authenticated_client: httpx.AsyncClient) -> None:
    response = await authenticated_client.get("/api/scan-runs/999999")

    assert response.status_code == 404


# ---------------------------------------------------------------------------
# Task 5 fix-wave Finding 2: the beat's in-flight guard (`schedule_scan_
# library`) must reclaim a stale `running` row the same way the API does.
# ---------------------------------------------------------------------------


async def test_schedule_scan_library_reclaims_stale_running_scan(
    db_session: AsyncSession, redis_url: str
) -> None:
    from app.tasks.scan import schedule_scan_library

    stale = ScanRun(state="running")
    db_session.add(stale)
    await db_session.commit()
    await db_session.refresh(stale)

    schedule_scan_library()

    await db_session.refresh(stale)
    assert stale.state == "failed"
    assert stale.finished_at is not None

    runs = (await db_session.execute(select(ScanRun))).scalars().all()
    assert len(runs) == 2  # the reclaimed stale run + the newly scheduled one
    scheduled = next(r for r in runs if r.id != stale.id)
    assert scheduled.state == "done"  # eager Celery ran scan_library inline


async def test_schedule_scan_library_skips_tick_when_lock_held(
    db_session: AsyncSession, redis_url: str
) -> None:
    from app.tasks.scan import schedule_scan_library

    client = aioredis.Redis.from_url(redis_url)
    await client.set(_SCAN_LOCK_KEY, "some-other-worker-token")
    try:
        db_session.add(ScanRun(state="running"))
        await db_session.commit()

        schedule_scan_library()

        runs = (await db_session.execute(select(ScanRun))).scalars().all()
        assert len(runs) == 1  # no new run scheduled, the running row untouched
        assert runs[0].state == "running"
    finally:
        await client.delete(_SCAN_LOCK_KEY)
        await client.aclose()
