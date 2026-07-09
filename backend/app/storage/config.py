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

from pydantic import BaseModel, Field, SecretStr, TypeAdapter, field_serializer


class LocalConfig(BaseModel):
    backend: Literal["local"] = "local"
    # POSIX path used as this backend's root; "" (the default) falls back to
    # `settings.library_root` (back-comparable with pre-Workstream-C
    # configs). A distinct, non-empty root lets multiple `local` backends
    # point at different directories (see `app.storage.registry`).
    root: str = ""


class SmbConfig(BaseModel):
    backend: Literal["smb"] = "smb"
    host: str  # IP or real DNS name (see Global Constraints)
    share: str  # SMB share name
    root: str = ""  # POSIX subpath within the share used as the library root ("" = share root)
    username: str
    password: SecretStr
    port: int = 445
    encrypt: bool = True  # SMB3 encryption (smbprotocol default)

    # M6 A2 (secure-by-default): ALWAYS emit the masked sentinel, never the
    # real secret -- `model_dump()` must never leak plaintext by default, so
    # callers that need the real value (persist/use paths) unwrap it
    # explicitly via `.get_secret_value()` instead of going through
    # `model_dump()` (see `app.services.storage_config.encrypt_config_secret`
    # and the SMB/S3 `StorageBackend` constructors).
    @field_serializer("password", when_used="always")
    def _ser_password(self, v: SecretStr) -> str:
        return "***"


class S3Config(BaseModel):
    backend: Literal["s3"] = "s3"
    bucket: str
    access_key: str
    secret_key: SecretStr
    endpoint_url: str | None = None  # None = real AWS; set for MinIO/other
    region: str | None = None
    prefix: str = ""  # key prefix used as the library root ("" = bucket root)
    addressing: Literal["path", "virtual"] = "path"  # MinIO needs "path"

    @field_serializer("secret_key", when_used="always")
    def _ser_secret_key(self, v: SecretStr) -> str:
        return "***"


StorageConfig = Annotated[LocalConfig | SmbConfig | S3Config, Field(discriminator="backend")]
_ADAPTER = TypeAdapter(StorageConfig)

# Per-backend secret field name (M6 A1: the single owner of this map -- both
# the encrypt-at-rest seam in app.services.storage_config and the
# GET/PUT-secret-merge logic in app.api.settings import it from here).
# Local has none.
SECRET_FIELD_BY_BACKEND: dict[str, str] = {"smb": "password", "s3": "secret_key"}


def parse_storage_config(data: dict) -> StorageConfig:
    """Validate a raw settings-row dict into the right per-backend model."""
    return _ADAPTER.validate_python(data)


def redacted(config: StorageConfig) -> dict:
    """JSON dict with secret fields masked, for GET responses.

    ``model_dump()`` already masks the secret field unconditionally (secure
    by default), but that means it can't distinguish "set" from "unset" --
    reading the real value's truthiness via ``.get_secret_value()`` (never a
    bare ``if config.password``, which a ``SecretStr`` object always
    satisfies regardless of its content) is what tells an empty secret apart
    from a set one here.
    """
    data = config.model_dump()
    if isinstance(config, SmbConfig):
        data["password"] = "***" if config.password.get_secret_value() else ""
    if isinstance(config, S3Config):
        data["secret_key"] = "***" if config.secret_key.get_secret_value() else ""
    return data
