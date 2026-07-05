"""Response schema for ``PUT /api/uploads`` (SPEC "Upload flow", Task 6)."""

from __future__ import annotations

import uuid

from pydantic import BaseModel


class UploadResult(BaseModel):
    file_id: int
    blob_hash: str
    size: int
    job_id: uuid.UUID
