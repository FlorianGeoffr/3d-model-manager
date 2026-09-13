"""Categories: a single-valued, exclusive grouping for models (R13b) --
distinct from `tags` (many-to-many). CRUD lives behind `app.api.categories`;
the nested shape a `ModelSummary`/`ModelDetail` embeds is
`app.schemas.library.ModelCategoryOut` instead (no `model_count` there).
"""

from __future__ import annotations

from pydantic import BaseModel

from app.schemas.library import NonEmptyStr, TagColor


class CategoryCreate(BaseModel):
    name: NonEmptyStr
    color: TagColor | None = None


class CategoryUpdate(BaseModel):
    """All fields optional; only the ones present in the request body are
    applied (`model_dump(exclude_unset=True)` in `app.api.categories`,
    mirrors `ModelPatch`/`PrintPatchIn`'s patch semantics).
    """

    name: NonEmptyStr | None = None
    color: TagColor | None = None


class CategoryOut(BaseModel):
    id: int
    name: str
    color: str | None = None
    # Number of models currently assigned to this category -- computed by
    # `app.services.categories` (one `GROUP BY`/`COUNT` for the whole list,
    # never per-category).
    model_count: int = 0
