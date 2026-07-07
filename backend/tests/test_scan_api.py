"""``POST /api/scan`` / ``GET /api/scan-runs[/{id}]`` (SPEC "Rescan/
reconcile"; Task 5 brief). Celery runs eager in tests, so a ``POST``
completes the whole scan inline before the response is returned.
"""

from __future__ import annotations

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ScanRun

pytestmark = pytest.mark.usefixtures("library_root")


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
        "verified": 0,
    }


async def test_post_scan_conflicts_with_running_scan(
    authenticated_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    db_session.add(ScanRun(state="running"))
    await db_session.commit()

    response = await authenticated_client.post("/api/scan")

    assert response.status_code == 409


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
