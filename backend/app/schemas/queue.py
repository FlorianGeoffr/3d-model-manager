"""Print queue: an ordered "models to print" worklist (Branch 4 Task 1)."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel

from app.schemas.library import ModelSummary


class QueueEnqueueIn(BaseModel):
    model_id: int


class QueueReorderIn(BaseModel):
    """``PATCH /queue/{entry_id}`` payload: move the entry to this 1-based
    position, clamped to ``[1, n]`` by the service layer.
    """

    position: int


class QueueEntryOut(BaseModel):
    id: int
    model_id: int
    position: int
    added_at: datetime
    model: ModelSummary
