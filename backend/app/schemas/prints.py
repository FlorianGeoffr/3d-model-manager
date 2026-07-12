"""Per-model print history (Branch 5 Task 1): a user-entered log of print
attempts, distinct from the print queue's worklist (``app.schemas.queue``)
and ``print_jobs``' live send-to-printer telemetry (M4).
"""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from pydantic import BaseModel, Field

from app.models.enums import PrintResult

if TYPE_CHECKING:
    from app.models.library import Print


class PrintCreateIn(BaseModel):
    """``POST /models/{model_id}/prints`` payload. An omitted ``printed_at``
    defaults to now (the DB column's own ``server_default=now()`` -- left
    unset here rather than resolved client-side so the server clock is
    authoritative).
    """

    printed_at: datetime | None = None
    printer_name: str | None = None
    filament: str | None = None
    result: PrintResult = PrintResult.SUCCESS
    duration_min: int | None = Field(default=None, ge=0)
    notes: str | None = None


class PrintPatchIn(BaseModel):
    """All fields optional; only the ones present in the request body are
    applied (``model_dump(exclude_unset=True)`` in ``app.api.prints``,
    mirrors ``ModelPatch``'s patch semantics).
    """

    printed_at: datetime | None = None
    printer_name: str | None = None
    filament: str | None = None
    result: PrintResult | None = None
    duration_min: int | None = Field(default=None, ge=0)
    notes: str | None = None


class PrintOut(BaseModel):
    id: int
    model_id: int
    printed_at: datetime
    printer_name: str | None
    filament: str | None
    result: PrintResult
    duration_min: int | None
    notes: str | None
    created_at: datetime

    @classmethod
    def from_model(cls, row: Print) -> PrintOut:
        return cls(
            id=row.id,
            model_id=row.model_id,
            printed_at=row.printed_at,
            printer_name=row.printer_name,
            filament=row.filament,
            result=row.result,
            duration_min=row.duration_min,
            notes=row.notes,
            created_at=row.created_at,
        )
