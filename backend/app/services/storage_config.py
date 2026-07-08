"""DB-backed active storage config + backend resolver (SPEC "Storage layer";
registry docstring's "M3 ... `get_backend` will read the active scheme/config
from the DB").

The active backend's connection config lives in the ``settings`` table under
key ``"storage"`` (Global Constraints "Backend selection is DB-driven"),
validated per-backend by ``app.storage.config``'s pydantic models. Absent
row -> ``LocalConfig()``, so a fresh install behaves exactly as M1/M2.

M6 A1: the backend's secret field (SMB ``password`` / S3 ``secret_key``) is
Fernet-encrypted before it ever reaches the DB, using the same
``app.crypto`` seam as the M4 printer access code. ``decrypt_config_row``
falls back to using a value as-is when it isn't valid Fernet ciphertext (a
pre-M6 plaintext row), so old installs keep reading correctly; the eager
startup pass in ``app.services.secrets_at_rest`` re-encrypts those rows.

Async functions serve the API (FastAPI dependencies); sync twins serve
Celery worker task bodies (``app.tasks.base.sync_session``), mirroring the
async/sync split already established by ``app.tasks.base``.
"""

from __future__ import annotations

from cryptography.fernet import InvalidToken
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.config import Settings
from app.crypto import decrypt_secret, encrypt_secret
from app.models import Setting
from app.storage.base import StorageBackend
from app.storage.config import (  # noqa: F401 -- S3Config/LocalConfig re-exported for callers
    SECRET_FIELD_BY_BACKEND,
    LocalConfig,
    S3Config,
    SmbConfig,
    StorageConfig,
    parse_storage_config,
)
from app.storage.registry import get_backend

SETTINGS_KEY = "storage"


def encrypt_config_secret(settings: Settings, config: StorageConfig) -> dict:
    """``model_dump`` the config with its secret field Fernet-encrypted (a
    no-op for ``LocalConfig`` or a backend whose secret is unset).

    M6 A2: ``model_dump()``'s secret field is now always the masked ``"***"``
    sentinel (secure by default -- see ``app.storage.config``), so the real
    plaintext is read straight off the ``config`` attribute via the explicit
    ``.get_secret_value()`` escape hatch instead, and always written back
    over whatever ``model_dump()`` put there -- no ``SecretStr`` object and
    no ``"***"`` sentinel ever reaches the at-rest JSONB.
    """
    data = config.model_dump()
    field = SECRET_FIELD_BY_BACKEND.get(data.get("backend"))
    if field:
        secret = getattr(config, field, None)  # a SecretStr | None
        plaintext = secret.get_secret_value() if secret is not None else None
        data[field] = encrypt_secret(settings, plaintext) if plaintext else ""
    return data


def decrypt_config_row(settings: Settings, data: dict) -> tuple[dict, bool]:
    """Decrypt the stored secret in-place on the given dict; the second
    element is ``True`` when the value wasn't Fernet ciphertext yet (a
    pre-M6 plaintext row) so the startup upgrade knows to re-write it. A
    non-Fernet string raises ``InvalidToken`` -> treat as already-plaintext
    (secrets map A1.4)."""
    field = SECRET_FIELD_BY_BACKEND.get(data.get("backend"))
    if not field or not data.get(field):
        return data, False
    try:
        data[field] = decrypt_secret(settings, data[field])
        return data, False
    except InvalidToken:
        return data, True


async def get_active_config(db: AsyncSession, settings: Settings) -> StorageConfig:
    row = await db.get(Setting, SETTINGS_KEY)
    if row is None:
        return LocalConfig()
    # Decrypt on a COPY of the JSONB value -- the getter must never write,
    # so the ORM-tracked dict on `row` is left untouched.
    data, _ = decrypt_config_row(settings, dict(row.value))
    return parse_storage_config(data)


def get_active_config_sync(session: Session, settings: Settings) -> StorageConfig:
    row = session.get(Setting, SETTINGS_KEY)
    if row is None:
        return LocalConfig()
    data, _ = decrypt_config_row(settings, dict(row.value))
    return parse_storage_config(data)


async def set_active_config(db: AsyncSession, settings: Settings, config: StorageConfig) -> None:
    value = encrypt_config_secret(settings, config)
    row = await db.get(Setting, SETTINGS_KEY)
    if row is None:
        db.add(Setting(key=SETTINGS_KEY, value=value))
    else:
        row.value = value
    await db.commit()


def set_active_config_sync(session: Session, settings: Settings, config: StorageConfig) -> None:
    value = encrypt_config_secret(settings, config)
    row = session.get(Setting, SETTINGS_KEY)
    if row is None:
        session.add(Setting(key=SETTINGS_KEY, value=value))
    else:
        row.value = value
    session.commit()


async def resolve_backend(db: AsyncSession, settings: Settings) -> StorageBackend:
    return get_backend(settings, await get_active_config(db, settings))


def resolve_backend_sync(session: Session, settings: Settings) -> StorageBackend:
    return get_backend(settings, get_active_config_sync(session, settings))
