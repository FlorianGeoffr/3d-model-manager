import pytest

from app.config import get_settings
from app.services.storage_config import (
    SETTINGS_KEY,
    get_active_config,
    resolve_backend,
    set_active_config,
)
from app.storage.config import LocalConfig, S3Config, SmbConfig, parse_storage_config, redacted
from app.storage.local import LocalStorageBackend


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


@pytest.mark.usefixtures("library_root")
async def test_active_config_defaults_to_local_when_absent(db_session):
    cfg = await get_active_config(db_session)
    assert isinstance(cfg, LocalConfig)


@pytest.mark.usefixtures("library_root")
async def test_set_then_get_round_trips(db_session):
    await set_active_config(db_session, S3Config(bucket="b", access_key="AK", secret_key="SK"))
    cfg = await get_active_config(db_session)
    assert isinstance(cfg, S3Config) and cfg.bucket == "b" and cfg.secret_key == "SK"


@pytest.mark.usefixtures("library_root")
async def test_resolve_backend_defaults_to_local(db_session):
    backend = await resolve_backend(db_session, get_settings())
    assert isinstance(backend, LocalStorageBackend)
