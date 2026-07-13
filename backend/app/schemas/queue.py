"""Print queue: an ordered "models to print" worklist (Branch 4 Task 1)."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel

from app.schemas.library import FileOut, ModelSummary


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
    # Round 8 Task 3: the newest (highest File.id) file on the model's
    # CURRENT revision whose blob is a sliced `.gcode.3mf`, if any -- lets a
    # queue row offer a "Print" action directly rather than sending the user
    # back to the model detail page. Deliberately NOT keyed off
    # `ModelSummary.has_sliced` (that means "metadata extracted", a
    # different condition -- see `library.newest_printable_files`). `None`
    # when the model has no current revision, or none of its current-
    # revision files are a sendable gcode_3mf yet.
    printable_file: FileOut | None = None
