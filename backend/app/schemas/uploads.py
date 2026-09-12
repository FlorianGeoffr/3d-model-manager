"""Response schema for ``PUT /api/uploads`` (SPEC "Upload flow", Task 6)."""

from __future__ import annotations

import uuid

from pydantic import BaseModel


class UploadResult(BaseModel):
    file_id: int
    blob_hash: str
    size: int
    job_id: uuid.UUID


class ExistingUploadModel(BaseModel):
    """The library model that already holds this content (R11-C item 18)."""

    slug: str
    name: str
    url: str


class DuplicateUploadOut(BaseModel):
    """``PUT /uploads`` 409 body: the uploaded blob's hash already exists
    elsewhere in the library. ``?allow_duplicate=true`` bypasses this."""

    detail: str = "duplicate"
    existing: ExistingUploadModel
    suggested_name: str
