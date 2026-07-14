"""Duplicate-files report (Branch 4 Task 1): files sharing a blob hash
across more than one model -- surfaces reclaimable storage from the same
content having been imported/uploaded more than once.

Round 11 Task 2 adds the resolve half: the client picks a "keeper" file per
duplicate group and the server deletes every other copy in that group.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, model_validator


class DuplicateFileOut(BaseModel):
    """``model_archived`` (Branch 4 fix-review F4): storage is per-file, so an
    archived model's bytes are still real wasted storage -- it stays in the
    report, just labeled, rather than being silently dropped.

    ``is_current_revision`` (Round 11 Task 2): whether this copy lives on its
    model's CURRENT revision -- a copy on a superseded revision can't be
    deleted (file ops are current-revision-only, same guard as
    ``DELETE /files/{id}``), so the client needs to know before offering it
    as a keeper/deletable choice.
    """

    model_id: int
    model_slug: str
    model_name: str
    model_archived: bool
    file_id: int
    file_name: str
    is_current_revision: bool


class DuplicateGroupOut(BaseModel):
    blob_hash: str
    size: int
    wasted_bytes: int
    files: list[DuplicateFileOut]


class DuplicatesReport(BaseModel):
    groups: list[DuplicateGroupOut]
    total_wasted_bytes: int


class KeepChoiceIn(BaseModel):
    """One duplicate group's keeper: ``blob_hash`` names the group, ``file_id``
    is the copy to keep -- every OTHER file in that group is a delete
    candidate."""

    blob_hash: str
    file_id: int


class DuplicatesResolveIn(BaseModel):
    """``POST /reports/duplicates/resolve`` payload (Round 11 Task 2). Groups
    not named in ``keep`` are left untouched -- the request is explicitly
    scoped to the groups it lists.
    """

    keep: list[KeepChoiceIn]

    @model_validator(mode="after")
    def _no_duplicate_group_choices(self) -> DuplicatesResolveIn:
        """More than one keeper choice for the same ``blob_hash`` is
        ambiguous (which one wins?) -- reject at the schema layer (422)
        rather than silently picking the last one, same "invalid request,
        not a partial one" posture as the 404s the service raises for
        unknown/mismatched choices.
        """
        seen: set[str] = set()
        duplicated: set[str] = set()
        for choice in self.keep:
            if choice.blob_hash in seen:
                duplicated.add(choice.blob_hash)
            seen.add(choice.blob_hash)
        if duplicated:
            raise ValueError(
                f"duplicate keep choices for group(s): {', '.join(sorted(duplicated))}"
            )
        return self


#: Why a named copy wasn't deleted. A closed set, mirrored by `SkipReason`
#: in web/src/api/types.ts -- the page treats the reasons differently (an
#: old-revision copy was never promised, so its skip isn't worth warning
#: about), which only stays honest if neither side can quietly grow a reason
#: the other doesn't know.
SkipReason = Literal["not_found", "not_current_revision", "store_pending", "keeper_missing"]


class SkippedCopyOut(BaseModel):
    file_id: int
    reason: SkipReason


class DuplicatesResolveOut(BaseModel):
    deleted: int
    reclaimed_bytes: int
    skipped: list[SkippedCopyOut]
