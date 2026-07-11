"""Duplicate-files report (Branch 4 Task 1)."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.schemas.reports import DuplicatesReport
from app.services import reports as reports_service

router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("/duplicates", response_model=DuplicatesReport)
async def get_duplicates_report(db: AsyncSession = Depends(get_db)) -> DuplicatesReport:
    return await reports_service.duplicate_files_report(db)
