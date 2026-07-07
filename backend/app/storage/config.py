"""Per-backend storage configuration models (SPEC "Storage layer": "config
validated per-backend via pydantic models in `settings`").

Each backend's connection details are validated into their own pydantic
model, discriminated on the ``backend`` field, and stored raw (as JSON) in
the ``settings`` table under key ``"storage"`` -- see
``app.services.storage_config``. This module owns only the shape of that
config; it knows nothing about the DB or the registry.
"""

from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, Field, TypeAdapter


class LocalConfig(BaseModel):
    backend: Literal["local"] = "local"


class SmbConfig(BaseModel):
    backend: Literal["smb"] = "smb"
    host: str  # IP or real DNS name (see Global Constraints)
    share: str  # SMB share name
    root: str = ""  # POSIX subpath within the share used as the library root ("" = share root)
    username: str
    password: str
    port: int = 445
    encrypt: bool = True  # SMB3 encryption (smbprotocol default)


class S3Config(BaseModel):
    backend: Literal["s3"] = "s3"
    bucket: str
    access_key: str
    secret_key: str
    endpoint_url: str | None = None  # None = real AWS; set for MinIO/other
    region: str | None = None
    prefix: str = ""  # key prefix used as the library root ("" = bucket root)
    addressing: Literal["path", "virtual"] = "path"  # MinIO needs "path"


StorageConfig = Annotated[LocalConfig | SmbConfig | S3Config, Field(discriminator="backend")]
_ADAPTER = TypeAdapter(StorageConfig)


def parse_storage_config(data: dict) -> StorageConfig:
    """Validate a raw settings-row dict into the right per-backend model."""
    return _ADAPTER.validate_python(data)


def redacted(config: StorageConfig) -> dict:
    """JSON dict with secret fields masked, for GET responses."""
    data = config.model_dump()
    if isinstance(config, SmbConfig):
        data["password"] = "***" if config.password else ""
    if isinstance(config, S3Config):
        data["secret_key"] = "***" if config.secret_key else ""
    return data
