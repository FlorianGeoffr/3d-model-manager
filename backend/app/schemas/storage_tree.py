"""`GET /storage/tree` (R13b): one level of the canonical storage layout
(`<slug>/<rev-dir>/<rel_path>`, see `app.services.layout.file_key`), derived
from `File.storage_path` prefixes -- no filesystem walk.
"""

from __future__ import annotations

from pydantic import BaseModel

from app.schemas.library import ModelSummary


class StorageTreeDirOut(BaseModel):
    name: str
    count: int


class StorageTreeOut(BaseModel):
    path: str
    dirs: list[StorageTreeDirOut]
    models: list[ModelSummary]
