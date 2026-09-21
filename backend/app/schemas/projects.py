"""Projects: grouping models/parts with workflow progress tracking.
CRUD lives behind `app.api.projects`.
"""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict

from app.schemas.library import NonEmptyStr, TagColor


class ProjectCreate(BaseModel):
    name: NonEmptyStr
    description: str | None = None
    color: TagColor | None = None


class ProjectUpdate(BaseModel):
    name: NonEmptyStr | None = None
    description: str | None = None
    color: TagColor | None = None


class ProjectOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    slug: str
    description: str | None = None
    color: str | None = None
    created_at: datetime
    updated_at: datetime
    model_count: int = 0
    total_quantity_target: int = 0
    total_quantity_printed: int = 0
    progress_pct: float = 0.0
