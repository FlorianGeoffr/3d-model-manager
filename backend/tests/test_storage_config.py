import json

import pytest

from app.config import get_settings
from app.services.storage_backends import get_default_backend_row
from app.services.storage_config import (
    SETTINGS_KEY,
    get_active_config,
    resolve_backend,
    set_active_config,
)
from app.storage.config import LocalConfig, S3Config, SmbConfig, parse_storage_config, redacted
from app.storage.local import LocalStorageBackend


def test_settings_key_is_storage():
    assert SETTINGS_KEY == "storage"


def test_parse_discriminates_by_backend():
    assert isinstance(parse_storage_config({"backend": "local"}), LocalConfig)
    smb = parse_storage_config(
        {"backend": "smb", "host": "h", "share": "s", "username": "u", "password": "p"}
    )
    assert isinstance(smb, SmbConfig) and smb.port == 445 and smb.encrypt is True


def test_redacted_masks_secrets():
    cfg = S3Config(bucket="b", access_key="AK", secret_key="SEKRIT")
    assert redacted(cfg)["secret_key"] == "***"
    assert redacted(cfg)["access_key"] == "AK"


def test_redacted_reports_empty_secret_as_empty_not_asterisks():
    """M6 A2: ``redacted()``'s truthiness must read the real secret via
    ``.get_secret_value()`` -- a ``SecretStr`` object itself is always
    truthy, so a naive ``if config.secret_key`` would mis-report an unset
    secret as ``"***"``."""
    cfg = S3Config(bucket="b", access_key="AK", secret_key="")
    assert redacted(cfg)["secret_key"] == ""


def test_smb_config_password_masked_by_default_in_repr_and_model_dump():
    """M6 A2 (secure-by-default): ``model_dump()`` must NEVER emit the real
    secret -- only the masked sentinel -- so a stray ``model_dump()`` call
    can't leak plaintext. Persist (``encrypt_config_secret``) and use
    (backend construction) paths read the real value only via the
    explicit ``.get_secret_value()`` escape hatch, never through
    ``model_dump()``."""
    c = SmbConfig(host="h", share="sh", username="u", password="hunter2")
    assert "hunter2" not in repr(c)
    dumped = c.model_dump()
    assert dumped["password"] == "***"  # never plaintext, never a SecretStr object
    json.dumps(dumped)  # JSONB/Celery-serializable
    assert c.password.get_secret_value() == "hunter2"  # the one explicit escape hatch


def test_s3_config_secret_key_masked_by_default_in_repr_and_model_dump():
    c = S3Config(bucket="b", access_key="AK", secret_key="hunter2")
    assert "hunter2" not in repr(c)
    dumped = c.model_dump()
    assert dumped["secret_key"] == "***"
    json.dumps(dumped)
    assert c.secret_key.get_secret_value() == "hunter2"


@pytest.mark.usefixtures("library_root")
async def test_active_config_defaults_to_local_when_absent(db_session):
    cfg = await get_active_config(db_session, get_settings())
    assert isinstance(cfg, LocalConfig)


@pytest.mark.usefixtures("library_root")
async def test_set_then_get_round_trips(db_session):
    settings = get_settings()
    await set_active_config(
        db_session, settings, S3Config(bucket="b", access_key="AK", secret_key="SK")
    )
    cfg = await get_active_config(db_session, settings)
    assert isinstance(cfg, S3Config) and cfg.bucket == "b"
    assert cfg.secret_key.get_secret_value() == "SK"


@pytest.mark.usefixtures("library_root")
async def test_set_active_config_writes_ciphertext_at_rest(db_session):
    """M6 A1: the stored secret must not be the plaintext we wrote.

    Workstream C: set_active_config now writes the DEFAULT storage_backends
    row (the source of truth get_active_config reads), not settings["storage"].
    """
    settings = get_settings()
    await set_active_config(
        db_session, settings, S3Config(bucket="b", access_key="AK", secret_key="super-secret")
    )
    default_row = await get_default_backend_row(db_session)
    assert default_row is not None
    assert default_row.config["secret_key"] != "super-secret"


@pytest.mark.usefixtures("library_root")
async def test_resolve_backend_defaults_to_local(db_session):
    backend = await resolve_backend(db_session, get_settings())
    assert isinstance(backend, LocalStorageBackend)
