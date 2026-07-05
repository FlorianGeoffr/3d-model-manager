"""Tags: global listing + get-or-create/remove per model (SPEC "API
surface", Task 5 brief).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.schemas.library import TagCreate, TagOut
from app.services import library

router = APIRouter(tags=["tags"])


@router.get("/tags", response_model=list[TagOut])
async def list_tags(db: AsyncSession = Depends(get_db)) -> list[TagOut]:
    return await library.list_tags(db)


@router.post("/models/{model_id}/tags", status_code=status.HTTP_201_CREATED, response_model=TagOut)
async def add_tag(model_id: int, payload: TagCreate, db: AsyncSession = Depends(get_db)) -> TagOut:
    return await library.add_tag_to_model(db, model_id, payload.name)


@router.delete("/models/{model_id}/tags/{name}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_tag(model_id: int, name: str, db: AsyncSession = Depends(get_db)) -> None:
    await library.remove_tag_from_model(db, model_id, name)
