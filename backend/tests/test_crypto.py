import stat

import pytest
from cryptography.fernet import Fernet, InvalidToken

from app.config import Settings
from app.crypto import (
    decrypt_secret,
    encrypt_secret,
    load_or_create_printer_key,
    printer_key_path,
)


def _settings(tmp_path, **kw) -> Settings:
    return Settings(data_dir=tmp_path / "data", **kw)


def test_round_trip(tmp_path):
    s = _settings(tmp_path)
    token = encrypt_secret(s, "12345678")
    assert token != "12345678"
    assert decrypt_secret(s, token) == "12345678"


def test_key_persisted_0600_and_reused(tmp_path):
    s = _settings(tmp_path)
    k1 = load_or_create_printer_key(s)
    path = printer_key_path(s)
    assert path.is_file()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert load_or_create_printer_key(s) == k1  # second call reuses, never regenerates
    # a token encrypted under the persisted key still decrypts on a fresh Settings
    token = encrypt_secret(s, "secret")
    assert decrypt_secret(_settings(tmp_path), token) == "secret"


def test_env_key_overrides_file(tmp_path):
    key = Fernet.generate_key().decode()
    s = _settings(tmp_path, printer_key=key)
    assert load_or_create_printer_key(s) == key.encode()
    assert not printer_key_path(s).exists()  # env key path never writes the file
    token = encrypt_secret(s, "x")
    # a Settings WITHOUT the env key (file-based, different key) cannot read it
    with pytest.raises(InvalidToken):
        decrypt_secret(_settings(tmp_path), token)


def test_tampered_token_raises(tmp_path):
    s = _settings(tmp_path)
    token = encrypt_secret(s, "hello")
    with pytest.raises(InvalidToken):
        decrypt_secret(s, token[:-4] + "AAAA")
