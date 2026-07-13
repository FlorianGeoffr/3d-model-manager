"""The app's lifespan wires up first-run bootstrap (``app.services.bootstrap``)
so a fresh deployment gets a usable admin login without any manual step.
``tests/test_bootstrap.py`` covers ``ensure_admin_user`` itself in detail;
this file only proves ``app.main`` actually calls it on startup.
"""

from pathlib import Path

import httpx
import pytest
from sqlalchemy import func, select

from app.config import get_settings
from app.db import get_sessionmaker
from app.main import create_app
from app.models import Setting, User


@pytest.fixture(autouse=True)
def _clear_settings_cache():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


async def test_lifespan_bootstraps_admin_user(
    migrated_db: str, monkeypatch: pytest.MonkeyPatch, data_dir: Path
) -> None:
    monkeypatch.setenv("ADMIN_USERNAME", "admin")
    monkeypatch.setenv("ADMIN_PASSWORD", "lifespan-startup-pw")
    get_settings.cache_clear()

    app = create_app()
    async with app.router.lifespan_context(app):
        async with get_sessionmaker()() as session:
            count = await session.scalar(select(func.count()).select_from(User))
        assert count == 1

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            response = await client.post(
                "/api/auth/login",
                json={"username": "admin", "password": "lifespan-startup-pw"},
            )
        assert response.status_code == 204


async def test_lifespan_bootstrap_is_idempotent_across_restarts(
    migrated_db: str, monkeypatch: pytest.MonkeyPatch, data_dir: Path
) -> None:
    monkeypatch.setenv("ADMIN_USERNAME", "admin")
    monkeypatch.setenv("ADMIN_PASSWORD", "lifespan-startup-pw")
    get_settings.cache_clear()

    app = create_app()
    async with app.router.lifespan_context(app):
        pass
    async with app.router.lifespan_context(app), get_sessionmaker()() as session:
        count = await session.scalar(select(func.count()).select_from(User))

    assert count == 1


async def test_lifespan_seeds_app_config_from_env(
    migrated_db: str, monkeypatch: pytest.MonkeyPatch, data_dir: Path
) -> None:
    """Round 10: the lifespan seeds the DB-backed ``app`` settings row from
    env on first boot (``app.services.app_config.seed_app_config``), AFTER
    ``ensure_admin_user`` -- see ``app.main.lifespan``.
    """
    monkeypatch.setenv("ADMIN_USERNAME", "admin")
    monkeypatch.setenv("ADMIN_PASSWORD", "lifespan-startup-pw")
    monkeypatch.setenv("PRINTER_ENABLED", "true")
    get_settings.cache_clear()

    app = create_app()
    async with app.router.lifespan_context(app), get_sessionmaker()() as session:
        row = await session.get(Setting, "app")

    assert row is not None
    assert row.value["printer_enabled"] is True
