"""Duplicate-files report (Branch 4 Task 1): files sharing a blob hash
across more than one model -- surfaces reclaimable storage from the same
content having been imported/uploaded more than once.
"""

from __future__ import annotations

from pydantic import BaseModel


class DuplicateFileOut(BaseModel):
    model_id: int
    model_slug: str
    model_name: str
    file_id: int
    file_name: str


class DuplicateGroupOut(BaseModel):
    blob_hash: str
    size: int
    wasted_bytes: int
    files: list[DuplicateFileOut]


class DuplicatesReport(BaseModel):
    groups: list[DuplicateGroupOut]
    total_wasted_bytes: int
