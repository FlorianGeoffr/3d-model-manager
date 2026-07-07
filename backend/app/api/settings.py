"""Storage settings API (Task 6 brief; Global Constraints "New endpoint
verbs"): read/set the active storage backend config (secrets redacted on
read), a connection-test probe against a candidate config, and the
migration-helper job that copies the whole library tree onto a new backend
before cutting over.

``PUT`` is a *direct* set -- for pointing at an already-populated or empty
backend with no copy needed. The safe "copy the existing library across,
verify, then cut over" path is ``POST /migrate`` (``app.tasks.migrate``).
"""

from __future__ import annotations

import uuid

import anyio
import pydantic
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.db import get_db
from app.schemas.jobs import JobOut
from app.schemas.settings import ConnectionTestOut, StorageConfigIn, StorageConfigOut
from app.services import jobs as jobs_service
from app.services import storage_config
from app.services.storage_probe import probe_backend
from app.storage.config import StorageConfig, parse_storage_config
from app.storage.registry import get_backend
from app.tasks.migrate import migrate_storage

router = APIRouter(prefix="/settings", tags=["settings"])


def _parse(payload: StorageConfigIn) -> StorageConfig:
    """Validate the flat ``{backend, config}`` request shape into the
    matching per-backend pydantic model.

    ``parse_storage_config`` is called directly against a hand-built dict
    here (not through FastAPI's own request-body validation), so a bad or
    incomplete config raises a plain ``pydantic.ValidationError`` rather than
    the ``RequestValidationError`` FastAPI auto-converts to 422 -- translate
    it by hand so an invalid config still 422s instead of 500ing.
    """
    try:
        return parse_storage_config({**payload.config, "backend": payload.backend})
    except pydantic.ValidationError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc


@router.get("/storage", response_model=StorageConfigOut)
async def get_storage_settings(db: AsyncSession = Depends(get_db)) -> StorageConfigOut:
    config = await storage_config.get_active_config(db)
    return StorageConfigOut.from_config(config)


@router.put("/storage", response_model=StorageConfigOut)
async def put_storage_settings(
    payload: StorageConfigIn, db: AsyncSession = Depends(get_db)
) -> StorageConfigOut:
    config = _parse(payload)
    await storage_config.set_active_config(db, config)
    return StorageConfigOut.from_config(config)


@router.post("/storage/test", response_model=ConnectionTestOut)
async def test_storage_settings(
    payload: StorageConfigIn, settings: Settings = Depends(get_settings)
) -> ConnectionTestOut:
    config = _parse(payload)
    backend = get_backend(settings, config)
    ok, detail, latency_ms = await anyio.to_thread.run_sync(probe_backend, backend)
    return ConnectionTestOut(ok=ok, detail=detail, latency_ms=latency_ms)


@router.post("/storage/migrate", response_model=JobOut)
async def migrate_storage_settings(
    payload: StorageConfigIn, db: AsyncSession = Depends(get_db)
) -> JobOut:
    config = _parse(payload)
    job = await jobs_service.create_job(
        db, id=uuid.uuid4(), type="migrate_storage", subject_type=None, subject_id=None
    )

    migrate_storage.apply_async(args=[str(job.id), config.model_dump()], task_id=str(job.id))

    # Under the test suite's eager Celery mode, the line above already ran
    # the whole migration inline through its own SYNC session -- refresh so
    # this (separate, async) session's identity map doesn't hand back the
    # stale "queued" snapshot from right after the insert (same reasoning as
    # app.api.scan.trigger_scan).
    await db.refresh(job)
    return JobOut.from_model(job)
