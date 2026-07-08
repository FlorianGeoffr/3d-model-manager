"""M6 A1: SMB/S3 storage secrets + the Thingiverse import token are
Fernet-encrypted at rest (mirroring the M4 printer-access-code seam), with an
eager, idempotent startup pass that upgrades any pre-M6 plaintext row. See
``app.crypto`` for the shared key/seam and ``app.services.secrets_at_rest``
for the startup pass.
"""

import pytest

from app.config import get_settings
from app.models import Setting
from app.services import storage_config
from app.services.secrets_at_rest import reencrypt_secrets_at_rest
from app.storage.config import SmbConfig


@pytest.mark.asyncio
async def test_set_active_config_writes_ciphertext_not_plaintext(db_session):
    s = get_settings()
    cfg = SmbConfig(host="h", share="sh", username="u", password="hunter2")
    await storage_config.set_active_config(db_session, s, cfg)
    row = await db_session.get(Setting, "storage")
    assert row.value["password"] != "hunter2"  # ciphertext at rest
    back = await storage_config.get_active_config(db_session, s)
    assert back.password.get_secret_value() == "hunter2"  # decrypts on read


@pytest.mark.asyncio
async def test_legacy_plaintext_row_reads_and_gets_reencrypted(db_session):
    s = get_settings()
    # simulate a pre-M6 install: a plaintext secret written straight to JSONB
    db_session.add(
        Setting(
            key="storage",
            value={
                "backend": "smb",
                "host": "h",
                "share": "sh",
                "root": "",
                "username": "u",
                "password": "plaintext123",
                "port": 445,
                "encrypt": True,
            },
        )
    )
    await db_session.commit()
    # read still works (InvalidToken -> use-as-is fallback)
    cfg = await storage_config.get_active_config(db_session, s)
    assert cfg.password.get_secret_value() == "plaintext123"
    # eager upgrade re-encrypts it at rest
    await reencrypt_secrets_at_rest(db_session, s)
    row = await db_session.get(Setting, "storage")
    assert row.value["password"] != "plaintext123"
    back = await storage_config.get_active_config(db_session, s)
    assert back.password.get_secret_value() == "plaintext123"


@pytest.mark.asyncio
async def test_reencrypt_pass_is_idempotent(db_session):
    """A second startup pass over already-encrypted rows writes nothing."""
    s = get_settings()
    db_session.add(
        Setting(
            key="storage",
            value={
                "backend": "smb",
                "host": "h",
                "share": "sh",
                "root": "",
                "username": "u",
                "password": "plaintext123",
                "port": 445,
                "encrypt": True,
            },
        )
    )
    db_session.add(Setting(key="import_tokens", value={"thingiverse_token": "plaintoken"}))
    await db_session.commit()

    await reencrypt_secrets_at_rest(db_session, s)
    storage_row = await db_session.get(Setting, "storage")
    token_row = await db_session.get(Setting, "import_tokens")
    storage_ciphertext = storage_row.value["password"]
    token_ciphertext = token_row.value["thingiverse_token"]

    # Second pass over already-ciphertext rows must be a true no-op.
    await reencrypt_secrets_at_rest(db_session, s)
    storage_row_again = await db_session.get(Setting, "storage")
    token_row_again = await db_session.get(Setting, "import_tokens")
    assert storage_row_again.value["password"] == storage_ciphertext
    assert token_row_again.value["thingiverse_token"] == token_ciphertext


@pytest.mark.asyncio
async def test_reencrypt_pass_handles_no_rows(db_session):
    """No storage/import_tokens rows at all (fresh install) -- must not raise."""
    s = get_settings()
    await reencrypt_secrets_at_rest(db_session, s)
