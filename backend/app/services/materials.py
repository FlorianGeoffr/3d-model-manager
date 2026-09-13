"""Materials: a user-defined filament/resin catalog (R13c) -- distinct from
``app.services.library``'s tag/category CRUD: a print may reference at most
one material (``Print.material_id``, ON DELETE SET NULL), and ``Print.
filament`` stays as a free-text fallback independent of this table.
"""

from __future__ import annotations

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.library import Material, Print
from app.schemas.materials import MaterialOut


async def list_materials(db: AsyncSession) -> list[MaterialOut]:
    """One `GROUP BY`/`COUNT` query for every material's `print_count`,
    never one per material."""
    rows = (
        await db.execute(
            select(Material, func.count(Print.id))
            .outerjoin(Print, Print.material_id == Material.id)
            .group_by(Material.id)
            .order_by(Material.name)
        )
    ).all()
    return [
        MaterialOut(
            id=m.id,
            name=m.name,
            kind=m.kind,
            color=m.color,
            vendor=m.vendor,
            notes=m.notes,
            print_count=count,
        )
        for m, count in rows
    ]


async def create_material(
    db: AsyncSession,
    *,
    name: str,
    kind: str | None,
    color: str | None,
    vendor: str | None,
    notes: str | None,
) -> MaterialOut:
    material = Material(name=name, kind=kind, color=color, vendor=vendor, notes=notes)
    db.add(material)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(status.HTTP_409_CONFLICT, f"material {name!r} already exists") from exc
    return MaterialOut(
        id=material.id,
        name=material.name,
        kind=material.kind,
        color=material.color,
        vendor=material.vendor,
        notes=material.notes,
        print_count=0,
    )


async def _get_material_or_404(db: AsyncSession, material_id: int) -> Material:
    material = await db.get(Material, material_id)
    if material is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"material {material_id} not found")
    return material


async def update_material(
    db: AsyncSession, material_id: int, changes: dict[str, object]
) -> MaterialOut:
    """Apply `changes` (already `exclude_unset`-filtered by the caller) --
    only fields present in the request body change."""
    material = await _get_material_or_404(db, material_id)
    for field in ("name", "kind", "color", "vendor", "notes"):
        if field in changes:
            setattr(material, field, changes[field])
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise HTTPException(
            status.HTTP_409_CONFLICT, f"material {changes.get('name')!r} already exists"
        ) from exc
    print_count = (
        await db.scalar(select(func.count(Print.id)).where(Print.material_id == material.id))
    ) or 0
    return MaterialOut(
        id=material.id,
        name=material.name,
        kind=material.kind,
        color=material.color,
        vendor=material.vendor,
        notes=material.notes,
        print_count=print_count,
    )


async def delete_material(db: AsyncSession, material_id: int) -> None:
    """Deletes the material row; `Print.material_id`'s `ON DELETE SET NULL`
    detaches every print that referenced it (`Print.filament` is left
    untouched, so its free-text snapshot survives) -- no application-level
    fixup needed here."""
    material = await _get_material_or_404(db, material_id)
    await db.delete(material)
    await db.commit()
