"""``GET /api/events`` SSE endpoint (Global Constraints: Redis pub/sub
channel ``tdmm:events``, JSON event shape; Task 6 interface decision).

Uses a real (loopback) uvicorn server rather than the usual
``ASGITransport``-backed ``client`` fixture: ``ASGITransport.handle_async_request``
awaits the whole ASGI app call to completion before handing back ANY
response bytes (see its source), which never happens for a deliberately
never-ending SSE stream -- a real socket is required to observe genuinely
incremental streaming.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest
import uvicorn

from app.config import get_settings
from app.main import create_app
from app.services.events import publish_job_event

ADMIN_USERNAME = "sse-admin"
ADMIN_PASSWORD = "sse-admin-password"


@pytest.fixture
async def live_client(
    migrated_db: str,
    redis_url: str,
    data_dir: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> AsyncIterator[httpx.AsyncClient]:
    """A real HTTP client against a real uvicorn server bound to loopback,
    already logged in as a freshly lifespan-bootstrapped admin user.
    """
    monkeypatch.setenv("TDMM_ADMIN_USERNAME", ADMIN_USERNAME)
    monkeypatch.setenv("TDMM_ADMIN_PASSWORD", ADMIN_PASSWORD)
    get_settings.cache_clear()

    app = create_app()
    config = uvicorn.Config(app, host="127.0.0.1", port=0, lifespan="on", log_level="warning")
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve())
    try:
        while not server.started:
            await asyncio.sleep(0.01)
        port = server.servers[0].sockets[0].getsockname()[1]

        async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}") as client:
            login = await client.post(
                "/api/auth/login",
                json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD},
            )
            assert login.status_code == 204, login.text
            yield client
    finally:
        server.should_exit = True
        await task
        get_settings.cache_clear()


async def test_sse_forwards_a_published_job_event(
    live_client: httpx.AsyncClient,
    redis_url: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Short heartbeat so the test can deterministically wait for "the
    # endpoint has subscribed" (its first heartbeat) before publishing,
    # instead of racing a fixed sleep against the subscribe call.
    monkeypatch.setenv("TDMM_SSE_HEARTBEAT_INTERVAL_S", "0.05")
    get_settings.cache_clear()

    async def _consume() -> tuple[dict, uuid.UUID]:
        async with live_client.stream("GET", "/api/events") as response:
            assert response.status_code == 200
            lines = response.aiter_lines()

            async for line in lines:
                if line.startswith(":"):
                    break

            published_job_id = uuid.uuid4()
            await publish_job_event(
                redis_url,
                job_id=published_job_id,
                job_type="store_to_backend",
                state="done",
                subject_type="file",
                subject_id=42,
            )

            async for line in lines:
                if line.startswith("data:"):
                    return json.loads(line[len("data:") :].strip()), published_job_id
            raise AssertionError("stream ended before the published event arrived")

    try:
        event, published_job_id = await asyncio.wait_for(_consume(), timeout=10)
    finally:
        get_settings.cache_clear()

    assert event["type"] == "job.updated"
    assert event["job_id"] == str(published_job_id)
    assert event["job_type"] == "store_to_backend"
    assert event["state"] == "done"
    assert event["subject_type"] == "file"
    assert event["subject_id"] == 42


async def test_sse_sends_heartbeat_when_idle(
    live_client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TDMM_SSE_HEARTBEAT_INTERVAL_S", "0.05")
    get_settings.cache_clear()

    async def _first_nonblank_line() -> str:
        async with live_client.stream("GET", "/api/events") as response:
            async for line in response.aiter_lines():
                if line:
                    return line
        raise AssertionError("stream ended without output")

    try:
        line = await asyncio.wait_for(_first_nonblank_line(), timeout=5)
    finally:
        get_settings.cache_clear()

    assert line.startswith(":")
