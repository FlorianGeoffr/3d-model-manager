"""Materials: a user-defined filament/resin catalog (R13c) -- distinct from
``prints.filament`` (a free-text per-print snapshot). CRUD lives behind
``app.api.materials``; the nested shape a ``PrintOut`` embeds is
``app.schemas.prints.PrintMaterialOut`` instead (no ``print_count`` there).
"""

from __future__ import annotations

import re

from pydantic import BaseModel, field_validator

from app.schemas.library import NonEmptyStr

_HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def _validate_color(value: str | None) -> str | None:
    if value is not None and not _HEX_COLOR_RE.match(value):
        raise ValueError("color must be a hex string like #RRGGBB")
    return value


class MaterialCreate(BaseModel):
    name: NonEmptyStr
    kind: str | None = None
    color: str | None = None
    vendor: str | None = None
    notes: str | None = None

    @field_validator("color")
    @classmethod
    def _check_color(cls, value: str | None) -> str | None:
        return _validate_color(value)


class MaterialUpdate(BaseModel):
    """All fields optional; only the ones present in the request body are
    applied (``model_dump(exclude_unset=True)`` in ``app.api.materials``,
    mirrors ``CategoryUpdate``/``ModelPatch``'s patch semantics).
    """

    name: NonEmptyStr | None = None
    kind: str | None = None
    color: str | None = None
    vendor: str | None = None
    notes: str | None = None

    @field_validator("color")
    @classmethod
    def _check_color(cls, value: str | None) -> str | None:
        return _validate_color(value)


class MaterialOut(BaseModel):
    id: int
    name: str
    kind: str | None = None
    color: str | None = None
    vendor: str | None = None
    notes: str | None = None
    # Number of prints currently referencing this material -- computed by
    # `app.services.materials` (one `GROUP BY`/`COUNT` for the whole list,
    # never per-material).
    print_count: int = 0
