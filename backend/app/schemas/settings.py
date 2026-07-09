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

from app.schemas.imports import NonEmptyStr

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


# Bambu Lab account connect flow (Workstream B task B2; SPEC full-design
# line 230 "Connect Bambu account" flow) -- see app.services.bambu_auth for
# the login/MFA/refresh contract and app.api.settings for the endpoints.
# NEITHER schema ever carries a token: login/verify accept only what the
# operator/browser types (account/password/code) or echoes back
# (mfa_context, an opaque continuation payload with no secret value of its
# own); the outputs below never include accessToken/refreshToken.


class BambuLoginIn(BaseModel):
    account: NonEmptyStr
    password: NonEmptyStr
    region: str = "global"


class BambuVerifyIn(BaseModel):
    account: NonEmptyStr
    code: NonEmptyStr
    region: str = "global"
    mfa_context: dict = {}


class BambuLoginOut(BaseModel):
    status: str  # "connected" | "mfa_required" -- never a token field
    account: str | None = None
    region: str | None = None
    mfa_context: dict | None = None


class BambuStatusOut(BaseModel):
    connected: bool
    account: str | None = None
    region: str = "global"
