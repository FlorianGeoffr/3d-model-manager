from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Annotated

from pydantic import BaseModel, StringConstraints

if TYPE_CHECKING:
    from app.models.system import Import

NonEmptyStr = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class ImportCreate(BaseModel):
    url: NonEmptyStr


class ImportOut(BaseModel):
    id: int
    url: str
    site: str
    external_id: str | None
    state: str
    model_id: int | None
    error: str | None
    meta: dict | None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_model(cls, imp: Import) -> ImportOut:
        return cls(
            id=imp.id,
            url=imp.url,
            site=imp.site,
            external_id=imp.external_id,
            state=imp.state,
            model_id=imp.model_id,
            error=imp.error,
            meta=imp.meta,
            created_at=imp.created_at,
            updated_at=imp.updated_at,
        )
