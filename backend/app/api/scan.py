"""Scan trigger + report API (SPEC "Rescan/reconcile"; Task 5 brief)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models import ScanRun
from app.schemas.scan import ScanRunOut
from app.tasks.scan import scan_library

router = APIRouter(tags=["scan"])

_IN_FLIGHT_STATES = ("queued", "running")


@router.post("/scan", status_code=status.HTTP_201_CREATED, response_model=ScanRunOut)
async def trigger_scan(db: AsyncSession = Depends(get_db)) -> ScanRunOut:
    existing = await db.scalar(select(ScanRun.id).where(ScanRun.state.in_(_IN_FLIGHT_STATES)))
    if existing is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "a scan is already running")

    scan_run = ScanRun(state="queued")
    db.add(scan_run)
    await db.commit()
    await db.refresh(scan_run)

    scan_library.apply_async(args=[scan_run.id])

    # Under the test suite's eager Celery mode, the line above already ran
    # the whole scan inline through its own SYNC session -- refresh so this
    # (separate, async) session's identity map doesn't hand back the stale
    # "queued" snapshot from right after the insert.
    await db.refresh(scan_run)
    return ScanRunOut.from_model(scan_run)


@router.get("/scan-runs", response_model=list[ScanRunOut])
async def list_scan_runs(
    limit: int = Query(20, ge=1, le=100), db: AsyncSession = Depends(get_db)
) -> list[ScanRunOut]:
    rows = (
        await db.execute(select(ScanRun).order_by(ScanRun.created_at.desc()).limit(limit))
    ).scalars()
    return [ScanRunOut.from_model(r) for r in rows]


@router.get("/scan-runs/{id}", response_model=ScanRunOut)
async def get_scan_run(id: int, db: AsyncSession = Depends(get_db)) -> ScanRunOut:
    scan_run = await db.get(ScanRun, id)
    if scan_run is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"scan run {id} not found")
    return ScanRunOut.from_model(scan_run)
