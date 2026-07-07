"""DB-backed active storage config + backend resolver (SPEC "Storage layer";
registry docstring's "M3 ... `get_backend` will read the active scheme/config
from the DB").

The active backend's connection config lives in the ``settings`` table under
key ``"storage"`` (Global Constraints "Backend selection is DB-driven"),
validated per-backend by ``app.storage.config``'s pydantic models. Absent
row -> ``LocalConfig()``, so a fresh install behaves exactly as M1/M2.

Async functions serve the API (FastAPI dependencies); sync twins serve
Celery worker task bodies (``app.tasks.base.sync_session``), mirroring the
async/sync split already established by ``app.tasks.base``.
"""

from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import Setting
from app.storage.base import StorageBackend
from app.storage.config import LocalConfig, StorageConfig, parse_storage_config
from app.storage.registry import get_backend

SETTINGS_KEY = "storage"


async def get_active_config(db: AsyncSession) -> StorageConfig:
    row = await db.get(Setting, SETTINGS_KEY)
    return LocalConfig() if row is None else parse_storage_config(row.value)


def get_active_config_sync(session: Session) -> StorageConfig:
    row = session.get(Setting, SETTINGS_KEY)
    return LocalConfig() if row is None else parse_storage_config(row.value)


async def set_active_config(db: AsyncSession, config: StorageConfig) -> None:
    row = await db.get(Setting, SETTINGS_KEY)
    if row is None:
        db.add(Setting(key=SETTINGS_KEY, value=config.model_dump()))
    else:
        row.value = config.model_dump()
    await db.commit()


def set_active_config_sync(session: Session, config: StorageConfig) -> None:
    row = session.get(Setting, SETTINGS_KEY)
    if row is None:
        session.add(Setting(key=SETTINGS_KEY, value=config.model_dump()))
    else:
        row.value = config.model_dump()
    session.commit()


async def resolve_backend(db: AsyncSession, settings: Settings) -> StorageBackend:
    return get_backend(settings, await get_active_config(db))


def resolve_backend_sync(session: Session, settings: Settings) -> StorageBackend:
    return get_backend(settings, get_active_config_sync(session))
