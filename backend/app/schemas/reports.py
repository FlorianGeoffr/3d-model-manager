"""Duplicate-files report (Branch 4 Task 1): files sharing a blob hash
across more than one model -- surfaces reclaimable storage from the same
content having been imported/uploaded more than once.
"""

from __future__ import annotations

from pydantic import BaseModel


class DuplicateFileOut(BaseModel):
    """``model_archived`` (Branch 4 fix-review F4): storage is per-file, so an
    archived model's bytes are still real wasted storage -- it stays in the
    report, just labeled, rather than being silently dropped.
    """

    model_id: int
    model_slug: str
    model_name: str
    model_archived: bool
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
