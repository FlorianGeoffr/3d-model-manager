"""`GET /storage/tree` (R13b): folder-browse view of the storage layout."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.db import get_db
from app.schemas.storage_tree import StorageTreeOut
from app.services import storage_tree as storage_tree_service

router = APIRouter(prefix="/storage", tags=["storage"])


@router.get("/tree", response_model=StorageTreeOut)
async def get_storage_tree(
    path: str = "",
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> StorageTreeOut:
    return await storage_tree_service.get_storage_tree(db, settings, path)
