"""Schemas for the storage settings API (SPEC "Storage layer"; Task 6
brief). ``StorageConfigIn``/``StorageConfigOut`` wrap the per-backend
pydantic models in ``app.storage.config`` behind the flat ``{backend,
config}`` shape Task 7's UI consumes -- the raw ``config`` dict is validated
via ``parse_storage_config`` on the way in (``app.api.settings``) and
produced via ``redacted()`` on the way out.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from pydantic import BaseModel

if TYPE_CHECKING:
    from app.storage.config import StorageConfig


class StorageConfigIn(BaseModel):
    backend: str
    config: dict = {}


class StorageConfigOut(BaseModel):
    backend: str
    config: dict

    @classmethod
    def from_config(cls, config: StorageConfig) -> StorageConfigOut:
        from app.storage.config import redacted

        return cls(backend=config.backend, config=redacted(config))


class ConnectionTestOut(BaseModel):
    ok: bool
    detail: str
    latency_ms: int
