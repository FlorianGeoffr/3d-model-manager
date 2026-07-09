"""Multi-backend storage CRUD + resolution (Workstream C task C1 design
spec: "run MULTIPLE storage backends at once; each file's bytes live on one
PRIMARY backend").

CRUD lives here over the ``storage_backends``/``file_locations`` tables
(``app.models.storage``); this module owns the single-default invariant (a
partial unique index on ``storage_backends.is_default`` backs it at the DB
level -- ``set_default_backend`` flips it atomically in one statement) and
the delete guardrails (refuse to delete the last backend, the default
backend, or one any ``file_locations`` row still points at).

Secrets are Fernet-encrypted at rest via the SAME
``app.services.storage_config.encrypt_config_secret``/``decrypt_config_row``
seam the legacy single-backend ``settings`` row already used -- this module
never invents a second encryption path. Every CRUD getter returns the row
AS STORED (encrypted); callers that need the live config
(``backend_for_id``/``resolve_default_backend``/``resolve_backend_for_file``
below, or an API response) must explicitly decrypt/parse it, same as
``app.services.storage_config`` always required.

Async functions serve the API; sync twins serve Celery worker task bodies
(``app.tasks.base.sync_session``), mirroring the split ``app.tasks.base``
and ``app.services.storage_config`` already establish.
"""

from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import File, FileLocation, StorageBackendRow
from app.services.storage_config import decrypt_config_row, encrypt_config_secret
from app.storage.base import StorageBackend
from app.storage.config import StorageConfig, parse_storage_config
from app.storage.registry import get_backend

# -- async: API-side ---------------------------------------------------


async def list_backends(db: AsyncSession) -> list[StorageBackendRow]:
    result = await db.execute(select(StorageBackendRow).order_by(StorageBackendRow.id))
    return list(result.scalars().all())


async def get_backend_row(db: AsyncSession, backend_id: int) -> StorageBackendRow:
    row = await db.get(StorageBackendRow, backend_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"storage backend {backend_id} not found")
    return row


async def get_default_backend_row(db: AsyncSession) -> StorageBackendRow | None:
    result = await db.execute(
        select(StorageBackendRow).where(StorageBackendRow.is_default.is_(True))
    )
    return result.scalar_one_or_none()


async def get_default_backend(db: AsyncSession) -> StorageBackendRow:
    row = await get_default_backend_row(db)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no default storage backend configured")
    return row


async def create_backend(
    db: AsyncSession,
    settings: Settings,
    name: str,
    config: StorageConfig,
    *,
    is_default: bool = False,
) -> StorageBackendRow:
    row = StorageBackendRow(
        name=name, scheme=config.backend, config=encrypt_config_secret(settings, config)
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    if is_default:
        row = await set_default_backend(db, row.id)
    return row


async def update_backend(
    db: AsyncSession,
    settings: Settings,
    backend_id: int,
    *,
    name: str | None = None,
    config: StorageConfig | None = None,
) -> StorageBackendRow:
    row = await get_backend_row(db, backend_id)
    if name is not None:
        row.name = name
    if config is not None:
        row.scheme = config.backend
        row.config = encrypt_config_secret(settings, config)
    await db.commit()
    await db.refresh(row)
    return row


async def delete_backend(db: AsyncSession, backend_id: int) -> None:
    """Refuse to delete a backend that's the last one, the default one, or
    one any ``file_locations`` row still references -- deleting it out from
    under a file with bytes still physically there would orphan them with no
    way to read them back.
    """
    row = await get_backend_row(db, backend_id)
    total = (await db.execute(select(func.count()).select_from(StorageBackendRow))).scalar_one()
    if total <= 1:
        raise HTTPException(status.HTTP_409_CONFLICT, "cannot delete the last storage backend")
    if row.is_default:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "cannot delete the default storage backend; set another one as default first",
        )
    in_use = (
        await db.execute(
            select(func.count())
            .select_from(FileLocation)
            .where(FileLocation.backend_id == backend_id)
        )
    ).scalar_one()
    if in_use:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"storage backend {backend_id} still holds {in_use} file(s); relocate them first",
        )
    await db.delete(row)
    await db.commit()


async def set_default_backend(db: AsyncSession, backend_id: int) -> StorageBackendRow:
    """Flip the single-default invariant atomically: a single ``UPDATE``
    that sets ``is_default`` true for ``backend_id`` and false for every
    other row in the same statement, so the partial unique index on
    ``is_default`` never sees two ``true`` rows at once (Postgres evaluates
    a multi-row ``UPDATE`` against a single pre-statement snapshot, so
    setting-while-clearing in one statement can't self-conflict the way two
    separate statements could).
    """
    row = await get_backend_row(db, backend_id)
    await db.execute(
        update(StorageBackendRow).values(is_default=(StorageBackendRow.id == backend_id))
    )
    await db.commit()
    await db.refresh(row)
    return row


async def backend_for_id(db: AsyncSession, settings: Settings, backend_id: int) -> StorageBackend:
    row = await get_backend_row(db, backend_id)
    data, _ = decrypt_config_row(settings, dict(row.config))
    return get_backend(settings, parse_storage_config(data))


async def resolve_default_backend(
    db: AsyncSession, settings: Settings
) -> tuple[StorageBackend, int]:
    """The write target: the default backend + its id (for stamping
    ``files.backend_id``/inserting a ``file_locations`` row).
    """
    row = await get_default_backend(db)
    data, _ = decrypt_config_row(settings, dict(row.config))
    return get_backend(settings, parse_storage_config(data)), row.id


async def resolve_backend_for_file(
    db: AsyncSession, settings: Settings, file: File
) -> StorageBackend:
    """The read source for ``file``: its own primary backend, or the
    default when ``backend_id`` is NULL (pre-migration-seed safety net --
    should not happen post-seed, but a NULL read must never explode).
    """
    if file.backend_id is not None:
        return await backend_for_id(db, settings, file.backend_id)
    backend, _ = await resolve_default_backend(db, settings)
    return backend


# -- sync: worker-side ---------------------------------------------------


def list_backends_sync(session: Session) -> list[StorageBackendRow]:
    result = session.execute(select(StorageBackendRow).order_by(StorageBackendRow.id))
    return list(result.scalars().all())


def get_backend_row_sync(session: Session, backend_id: int) -> StorageBackendRow:
    row = session.get(StorageBackendRow, backend_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"storage backend {backend_id} not found")
    return row


def get_default_backend_row_sync(session: Session) -> StorageBackendRow | None:
    result = session.execute(
        select(StorageBackendRow).where(StorageBackendRow.is_default.is_(True))
    )
    return result.scalar_one_or_none()


def get_default_backend_sync(session: Session) -> StorageBackendRow:
    row = get_default_backend_row_sync(session)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no default storage backend configured")
    return row


def create_backend_sync(
    session: Session,
    settings: Settings,
    name: str,
    config: StorageConfig,
    *,
    is_default: bool = False,
) -> StorageBackendRow:
    row = StorageBackendRow(
        name=name, scheme=config.backend, config=encrypt_config_secret(settings, config)
    )
    session.add(row)
    session.commit()
    session.refresh(row)
    if is_default:
        row = set_default_backend_sync(session, row.id)
    return row


def update_backend_sync(
    session: Session,
    settings: Settings,
    backend_id: int,
    *,
    name: str | None = None,
    config: StorageConfig | None = None,
) -> StorageBackendRow:
    row = get_backend_row_sync(session, backend_id)
    if name is not None:
        row.name = name
    if config is not None:
        row.scheme = config.backend
        row.config = encrypt_config_secret(settings, config)
    session.commit()
    session.refresh(row)
    return row


def delete_backend_sync(session: Session, backend_id: int) -> None:
    row = get_backend_row_sync(session, backend_id)
    total = session.execute(select(func.count()).select_from(StorageBackendRow)).scalar_one()
    if total <= 1:
        raise HTTPException(status.HTTP_409_CONFLICT, "cannot delete the last storage backend")
    if row.is_default:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "cannot delete the default storage backend; set another one as default first",
        )
    in_use = session.execute(
        select(func.count()).select_from(FileLocation).where(FileLocation.backend_id == backend_id)
    ).scalar_one()
    if in_use:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"storage backend {backend_id} still holds {in_use} file(s); relocate them first",
        )
    session.delete(row)
    session.commit()


def set_default_backend_sync(session: Session, backend_id: int) -> StorageBackendRow:
    row = get_backend_row_sync(session, backend_id)
    session.execute(
        update(StorageBackendRow).values(is_default=(StorageBackendRow.id == backend_id))
    )
    session.commit()
    session.refresh(row)
    return row


def backend_for_id_sync(session: Session, settings: Settings, backend_id: int) -> StorageBackend:
    row = get_backend_row_sync(session, backend_id)
    data, _ = decrypt_config_row(settings, dict(row.config))
    return get_backend(settings, parse_storage_config(data))


def resolve_default_backend_sync(
    session: Session, settings: Settings
) -> tuple[StorageBackend, int]:
    row = get_default_backend_sync(session)
    data, _ = decrypt_config_row(settings, dict(row.config))
    return get_backend(settings, parse_storage_config(data)), row.id


def resolve_backend_for_file_sync(
    session: Session, settings: Settings, file: File
) -> StorageBackend:
    if file.backend_id is not None:
        return backend_for_id_sync(session, settings, file.backend_id)
    backend, _ = resolve_default_backend_sync(session, settings)
    return backend
