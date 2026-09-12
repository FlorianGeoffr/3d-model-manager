"""Per-model print history (Branch 5 Task 1): a user-entered log of print
attempts, distinct from the print queue's worklist (``app.schemas.queue``)
and ``print_jobs``' live send-to-printer telemetry (M4).
"""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING

from pydantic import BaseModel, Field, field_validator

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
    filament_g: float | None = Field(default=None, ge=0)
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
    filament_g: float | None = Field(default=None, ge=0)
    result: PrintResult | None = None
    duration_min: int | None = Field(default=None, ge=0)
    notes: str | None = None

    @field_validator("printed_at", "result")
    @classmethod
    def _reject_explicit_null(cls, value: object) -> object:
        """``printed_at``/``result`` are NOT-NULL columns -- an *absent* field
        is fine (``exclude_unset`` drops it before it reaches the service
        layer), but an explicit ``null`` would otherwise sail through this
        `T | None` typing and hit the DB as a NOT-NULL violation (500)
        instead of a clean 422.
        """
        if value is None:
            raise ValueError("field cannot be null")
        return value


class PrintOut(BaseModel):
    id: int
    model_id: int
    printed_at: datetime
    printer_name: str | None
    filament: str | None
    filament_g: float | None
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
            filament_g=row.filament_g,
            result=row.result,
            duration_min=row.duration_min,
            notes=row.notes,
            created_at=row.created_at,
        )
