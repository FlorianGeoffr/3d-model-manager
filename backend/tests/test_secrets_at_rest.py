"""M6 A1: SMB/S3 storage secrets + the Thingiverse/MakerWorld import tokens
(task A5 added the MakerWorld field) are Fernet-encrypted at rest (mirroring
the M4 printer-access-code seam), with an eager, idempotent startup pass
that upgrades any pre-M6 plaintext row. See ``app.crypto`` for the shared
key/seam and ``app.services.secrets_at_rest`` for the startup pass.
"""

import pytest

from app.config import get_settings
from app.crypto import encrypt_secret
from app.models import Setting
from app.services import storage_config
from app.services.import_tokens import get_import_tokens
from app.services.secrets_at_rest import reencrypt_secrets_at_rest
from app.services.storage_backends import get_default_backend_row
from app.storage.config import SmbConfig


@pytest.mark.asyncio
async def test_set_active_config_writes_ciphertext_not_plaintext(db_session):
    s = get_settings()
    cfg = SmbConfig(host="h", share="sh", username="u", password="hunter2")
    await storage_config.set_active_config(db_session, s, cfg)
    # Workstream C: set_active_config now writes the DEFAULT storage_backends
    # row (what get_active_config reads), not settings["storage"].
    default_row = await get_default_backend_row(db_session)
    assert default_row is not None
    assert default_row.config["password"] != "hunter2"  # ciphertext at rest
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
async def test_legacy_plaintext_makerworld_token_gets_reencrypted_without_dropping_thingiverse(
    db_session,
):
    """A row holding a plaintext ``makerworld_token`` alongside an already-
    encrypted ``thingiverse_token`` must have the makerworld field
    re-encrypted WITHOUT the pass dropping the sibling field (task A5)."""
    s = get_settings()
    db_session.add(
        Setting(
            key="import_tokens",
            value={
                "thingiverse_token": encrypt_secret(s, "tv-secret"),
                "makerworld_token": "plain-mw-secret",
            },
        )
    )
    await db_session.commit()

    await reencrypt_secrets_at_rest(db_session, s)

    row = await db_session.get(Setting, "import_tokens")
    assert row.value["makerworld_token"] != "plain-mw-secret"  # now ciphertext
    assert row.value["thingiverse_token"] != "plain-mw-secret"  # thingiverse untouched by the pass

    decoded = await get_import_tokens(db_session, s)
    assert decoded.makerworld_token == "plain-mw-secret"
    assert decoded.thingiverse_token == "tv-secret"  # sibling untouched


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
    db_session.add(
        Setting(
            key="import_tokens",
            value={"thingiverse_token": "plaintoken", "makerworld_token": "plainmwtoken"},
        )
    )
    await db_session.commit()

    await reencrypt_secrets_at_rest(db_session, s)
    storage_row = await db_session.get(Setting, "storage")
    token_row = await db_session.get(Setting, "import_tokens")
    storage_ciphertext = storage_row.value["password"]
    token_ciphertext = token_row.value["thingiverse_token"]
    makerworld_ciphertext = token_row.value["makerworld_token"]

    # Second pass over already-ciphertext rows must be a true no-op.
    await reencrypt_secrets_at_rest(db_session, s)
    storage_row_again = await db_session.get(Setting, "storage")
    token_row_again = await db_session.get(Setting, "import_tokens")
    assert storage_row_again.value["password"] == storage_ciphertext
    assert token_row_again.value["thingiverse_token"] == token_ciphertext
    assert token_row_again.value["makerworld_token"] == makerworld_ciphertext


@pytest.mark.asyncio
async def test_reencrypt_pass_handles_no_rows(db_session):
    """No storage/import_tokens rows at all (fresh install) -- must not raise."""
    s = get_settings()
    await reencrypt_secrets_at_rest(db_session, s)
