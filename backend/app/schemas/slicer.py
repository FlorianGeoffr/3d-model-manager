"""Response schema for ``POST /api/slicer/intake`` (Round 8 Task 4: Bambu
Studio post-processing intake)."""

from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel


class IntakeOut(BaseModel):
    model_id: int
    model_name: str
    file_id: int
    blob_hash: str
    size: int
    job_id: uuid.UUID
    action: Literal["created", "attached", "replaced"]
