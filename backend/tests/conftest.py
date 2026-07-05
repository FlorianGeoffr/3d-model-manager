"""Shared test fixtures: a real Postgres testcontainer + the real migration.

Per the M1 global constraints, DB tests run against REAL PostgreSQL via
testcontainers -- never mocked, never SQLite. The schema is created by
applying the actual Alembic baseline migration (not
``Base.metadata.create_all``), so these tests also validate the migration
itself.
"""

import os
from collections.abc import AsyncGenerator, Iterator
from pathlib import Path

import httpx
import pytest
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from testcontainers.postgres import PostgresContainer

from alembic import command
from app.config import get_settings
from app.db import get_engine, get_sessionmaker
from app.main import create_app
from app.models import Base

BACKEND_DIR = Path(__file__).resolve().parent.parent


def _reset_settings_and_engine_caches() -> None:
    """``get_settings``/``get_engine``/``get_sessionmaker`` are ``lru_cache``d
    process-wide singletons (see app.config, app.db). Tests that repoint
    ``TDMM_DATABASE_URL`` must clear all three so a fresh engine is built
    against the new URL.
    """
    get_settings.cache_clear()
    get_engine.cache_clear()
    get_sessionmaker.cache_clear()


@pytest.fixture(scope="session")
def postgres_url() -> Iterator[str]:
    """Start one Postgres container for the whole test session."""
    with PostgresContainer("postgres:16-alpine") as container:
        url = container.get_connection_url(driver="asyncpg")
        os.environ["TDMM_DATABASE_URL"] = url
        _reset_settings_and_engine_caches()
        yield url
    del os.environ["TDMM_DATABASE_URL"]
    _reset_settings_and_engine_caches()


@pytest.fixture(scope="session")
def migrated_db(postgres_url: str) -> str:
    """Apply the real baseline Alembic migration against the container."""
    config = Config(str(BACKEND_DIR / "alembic.ini"))
    command.upgrade(config, "head")
    return postgres_url


@pytest.fixture(autouse=True)
async def _truncate_all_tables(migrated_db: str) -> AsyncGenerator[None, None]:
    """Empty every app table before each test function runs."""
    table_names = ", ".join(f'"{t.name}"' for t in Base.metadata.sorted_tables)
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.execute(text(f"TRUNCATE TABLE {table_names} RESTART IDENTITY CASCADE"))
    yield


@pytest.fixture
async def db_session(_truncate_all_tables: None) -> AsyncGenerator[AsyncSession, None]:
    """A function-scoped async session against the migrated testcontainer DB."""
    async with get_sessionmaker()() as session:
        yield session


@pytest.fixture
async def client(migrated_db: str) -> AsyncGenerator[httpx.AsyncClient, None]:
    """An ASGI test client for the app, wired to the container DB."""
    app = create_app()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
