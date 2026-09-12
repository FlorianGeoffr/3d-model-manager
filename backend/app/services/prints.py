"""Per-model print history (Branch 5 Task 1): a user-entered log of print
attempts, distinct from the ``print_queue`` "to print" worklist
(``app.services.queue``) and ``print_jobs``' live send-to-printer telemetry
(M4). The API layer (``app.api.prints``) already resolves/404s the parent
model for the two model-scoped routes, so ``model_id`` here is trusted.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.enums import PrintResult
from app.models.library import Print
from app.schemas.prints import PrintOut


async def create_print(
    db: AsyncSession,
    model_id: int,
    *,
    printed_at: datetime | None,
    printer_name: str | None,
    filament: str | None,
    filament_g: float | None = None,
    result: PrintResult,
    duration_min: int | None,
    notes: str | None,
) -> PrintOut:
    row = Print(
        model_id=model_id,
        printer_name=printer_name,
        filament=filament,
        filament_g=filament_g,
        result=result,
        duration_min=duration_min,
        notes=notes,
    )
    if printed_at is not None:
        row.printed_at = printed_at
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return PrintOut.from_model(row)


async def list_prints(db: AsyncSession, model_id: int) -> list[PrintOut]:
    """Reverse-chronological by ``printed_at``, ``id`` desc as a tiebreak for
    rows sharing the same (possibly explicitly-set) ``printed_at``.
    """
    stmt = (
        select(Print)
        .where(Print.model_id == model_id)
        .order_by(Print.printed_at.desc(), Print.id.desc())
    )
    rows = (await db.execute(stmt)).scalars().all()
    return [PrintOut.from_model(row) for row in rows]


async def _get_print_or_404(db: AsyncSession, print_id: int) -> Print:
    row = await db.get(Print, print_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"print {print_id} not found")
    return row


async def patch_print(db: AsyncSession, print_id: int, changes: dict[str, object]) -> PrintOut:
    """Apply ``changes`` (already ``exclude_unset``-filtered by the caller) --
    only the fields present in the request body change.
    """
    row = await _get_print_or_404(db, print_id)
    for field in (
        "printed_at",
        "printer_name",
        "filament",
        "filament_g",
        "result",
        "duration_min",
        "notes",
    ):
        if field in changes:
            setattr(row, field, changes[field])
    await db.commit()
    await db.refresh(row)
    return PrintOut.from_model(row)


async def delete_print(db: AsyncSession, print_id: int) -> None:
    row = await _get_print_or_404(db, print_id)
    await db.delete(row)
    await db.commit()
