"""Fernet encryption for at-rest secrets (SPEC ``printers.access_code_enc
/*fernet*/``; M4). The key lives at ``{data_dir}/secrets/printer.key``
(0600) or comes from ``TDMM_PRINTER_KEY``; it is loaded ONLY where an
adapter is built (the send task, printerd, the test-connection probe) --
never eagerly at import, and the decrypted plaintext is never logged,
returned, or published (Global Constraints).
"""

from __future__ import annotations

from pathlib import Path

from cryptography.fernet import Fernet

from app.config import Settings


def printer_key_path(settings: Settings) -> Path:
    return Path(settings.data_dir) / "secrets" / "printer.key"


def load_or_create_printer_key(settings: Settings) -> bytes:
    if settings.printer_key:
        return settings.printer_key.encode()
    path = printer_key_path(settings)
    if path.exists():
        return path.read_bytes()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    key = Fernet.generate_key()
    # Write private then tighten mode (umask-independent).
    path.write_bytes(key)
    path.chmod(0o600)
    return key


def get_fernet(settings: Settings) -> Fernet:
    return Fernet(load_or_create_printer_key(settings))


def encrypt_secret(settings: Settings, plaintext: str) -> str:
    return get_fernet(settings).encrypt(plaintext.encode()).decode()


def decrypt_secret(settings: Settings, token: str) -> str:
    return get_fernet(settings).decrypt(token.encode()).decode()
