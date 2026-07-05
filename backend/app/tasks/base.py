"""Worker-side (SYNC) database access -- deliberately separate from the
API's async engine (``app.db``).

**Why a second engine:** Celery task bodies are plain synchronous functions
run by prefork worker processes. Bridging them onto the app's async engine
(``asyncpg``, via ``app.db``) would mean either spinning up a fresh event
loop per task with ``asyncio.run(...)`` (fragile: ``asyncpg`` connections
and pools are not safe to hand across event loops, and prefork workers fork
*before* any loop exists) or keeping a long-lived loop alongside Celery's own
process/concurrency model. Neither is worth it for a handful of small
read/update queries per task.

**What we do instead:** a dedicated SYNC SQLAlchemy engine using the
``psycopg`` (3) driver, built by swapping only the URL *scheme* on the same
``TDMM_DATABASE_URL`` (``postgresql+asyncpg://`` -> ``postgresql+psycopg://``).
``asyncpg``/``app.db``'s async engine stay strictly API-side; this module's
sync engine stays strictly worker-side. The two never share a connection
pool, a session, or an event loop -- API = async world, worker = sync world,
and the boundary is exactly this module.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from functools import lru_cache

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import get_settings

_ASYNC_SCHEME = "postgresql+asyncpg://"
_SYNC_SCHEME = "postgresql+psycopg://"


def _sync_database_url(database_url: str) -> str:
    """Swap the asyncpg URL scheme for psycopg's; pass through unchanged if
    the URL is already using some other scheme (e.g. already ``+psycopg``).
    """
    if database_url.startswith(_ASYNC_SCHEME):
        return _SYNC_SCHEME + database_url[len(_ASYNC_SCHEME) :]
    return database_url


@lru_cache
def get_sync_engine():
    """Return the process-wide cached sync engine (mirrors ``app.db.get_engine``)."""
    settings = get_settings()
    return create_engine(_sync_database_url(settings.database_url), pool_pre_ping=True)


@lru_cache
def get_sync_sessionmaker() -> sessionmaker[Session]:
    """Return the process-wide cached sync session factory."""
    return sessionmaker(get_sync_engine(), expire_on_commit=False)


@contextmanager
def sync_session() -> Iterator[Session]:
    """A worker-scoped sync ``Session`` as a context manager."""
    session = get_sync_sessionmaker()()
    try:
        yield session
    finally:
        session.close()
