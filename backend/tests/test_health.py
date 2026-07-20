"""Tests for the unauthenticated health endpoint."""

import httpx
import pytest

from app.config import get_settings
from app.main import create_app


@pytest.fixture
async def client():
    app = create_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


async def test_health_returns_ok(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/health")

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    # Asserted against the settings rather than a literal: an unstamped run
    # (bare `uvicorn`, plain `pytest`) reports the `dev` default, while a
    # CI/Docker build reports whatever APP_VERSION was baked into the image.
    assert body["version"] == get_settings().app_version


async def test_health_reports_the_env_supplied_version(monkeypatch: pytest.MonkeyPatch) -> None:
    """APP_VERSION must reach both ``app.version`` and the health payload.

    This is the contract the release pipeline relies on: CI passes
    ``--build-arg APP_VERSION=<semver>``, docker/Dockerfile turns it into an
    env var, and the running container has to report it back -- on
    /api/openapi.json's ``info.version`` and on GET /api/health alike.
    """
    monkeypatch.setenv("APP_VERSION", "9.9.9")
    get_settings.cache_clear()
    try:
        app = create_app()
        assert app.version == "9.9.9"

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
            response = await ac.get("/api/health")

        assert response.status_code == 200
        assert response.json()["version"] == "9.9.9"
    finally:
        # The cache is process-wide and lru_cache'd, so a stale 9.9.9 would
        # leak into every later test in this session.
        get_settings.cache_clear()
