"""Dashboard stats API (R11-B item 13): one cheap aggregate endpoint the
frontend's `/dashboard` page polls. See `app.services.stats` for the
30s in-process cache and the actual queries.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.db import get_db
from app.schemas.stats import StatsOut
from app.services import stats as stats_service

router = APIRouter(tags=["stats"])


@router.get("/stats", response_model=StatsOut)
async def get_stats(
    db: AsyncSession = Depends(get_db), settings: Settings = Depends(get_settings)
) -> StatsOut:
    return await stats_service.get_stats(db, settings)
