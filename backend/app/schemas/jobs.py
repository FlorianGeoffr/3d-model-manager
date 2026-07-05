"""Response schema for ``GET /api/jobs`` / ``POST /api/jobs/{id}/retry``
(SPEC ``jobs``, Task 6).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from pydantic import BaseModel

if TYPE_CHECKING:
    from app.models import Job


class JobOut(BaseModel):
    id: uuid.UUID
    celery_id: str | None
    type: str
    subject_type: str | None
    subject_id: int | None
    state: str
    attempts: int
    error: str | None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_model(cls, job: Job) -> JobOut:
        return cls(
            id=job.id,
            celery_id=job.celery_id,
            type=job.type,
            subject_type=job.subject_type,
            subject_id=job.subject_id,
            state=job.state,
            attempts=job.attempts,
            error=job.error,
            created_at=job.created_at,
            updated_at=job.updated_at,
        )
