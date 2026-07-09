from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Annotated

from pydantic import BaseModel, StringConstraints

if TYPE_CHECKING:
    from app.importers.base import SearchResult
    from app.models.system import Import

NonEmptyStr = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]


class ImportCreate(BaseModel):
    url: NonEmptyStr


class ImportOut(BaseModel):
    id: int
    url: str
    site: str
    external_id: str | None
    state: str
    model_id: int | None
    error: str | None
    meta: dict | None
    created_at: datetime
    updated_at: datetime

    @classmethod
    def from_model(cls, imp: Import) -> ImportOut:
        return cls(
            id=imp.id,
            url=imp.url,
            site=imp.site,
            external_id=imp.external_id,
            state=imp.state,
            model_id=imp.model_id,
            error=imp.error,
            meta=imp.meta,
            created_at=imp.created_at,
            updated_at=imp.updated_at,
        )


class SearchResultOut(BaseModel):
    """Mirrors ``app.importers.base.SearchResult`` (Workstream B task B1,
    ``GET /imports/search``)."""

    site: str
    external_id: str
    title: str
    url: str
    author: str | None = None
    thumbnail_url: str | None = None

    @classmethod
    def from_dataclass(cls, r: SearchResult) -> SearchResultOut:
        return cls(
            site=r.site.value,
            external_id=r.external_id,
            title=r.title,
            url=r.url,
            author=r.author,
            thumbnail_url=r.thumbnail_url,
        )


class ImportTokensIn(BaseModel):
    thingiverse_token: str = ""


class ImportTokensOut(BaseModel):
    thingiverse_token: str  # "***" when a token is stored, "" otherwise -- never the real value
