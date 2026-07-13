"""Async SQLAlchemy engine/session plumbing and the ``get_db`` FastAPI dependency.

Engine and sessionmaker are built lazily behind ``lru_cache`` (mirroring
``app.config.get_settings``) rather than at import time, so tests that point
``DATABASE_URL`` at a testcontainer can force a rebuild via
``get_engine.cache_clear()`` / ``get_sessionmaker.cache_clear()`` after
changing the env and clearing ``get_settings``'s cache.
"""

from collections.abc import AsyncGenerator
from functools import lru_cache

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.config import get_settings


@lru_cache
def get_engine() -> AsyncEngine:
    """Return the process-wide cached async engine."""
    settings = get_settings()
    return create_async_engine(settings.database_url, pool_pre_ping=True)


@lru_cache
def get_sessionmaker() -> async_sessionmaker[AsyncSession]:
    """Return the process-wide cached async session factory."""
    return async_sessionmaker(get_engine(), expire_on_commit=False)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency yielding a request-scoped ``AsyncSession``."""
    async with get_sessionmaker()() as session:
        yield session
