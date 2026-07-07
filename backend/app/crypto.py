"""Fernet encryption for at-rest secrets (SPEC ``printers.access_code_enc
/*fernet*/``; M4). The key lives at ``{data_dir}/secrets/printer.key``
(0600) or comes from ``TDMM_PRINTER_KEY``; it is loaded ONLY where an
adapter is built (the send task, printerd, the test-connection probe) --
never eagerly at import, and the decrypted plaintext is never logged,
returned, or published (Global Constraints).
"""

from __future__ import annotations

import os
from pathlib import Path

from cryptography.fernet import Fernet

from app.config import Settings


def printer_key_path(settings: Settings) -> Path:
    return settings.data_dir / "secrets" / "printer.key"


def _read_existing_key(path: Path) -> bytes:
    # Defensively tighten perms on load in case the file was ever restored
    # or created with looser permissions than we require.
    path.chmod(0o600)
    return path.read_bytes()


def load_or_create_printer_key(settings: Settings) -> bytes:
    if settings.printer_key:
        return settings.printer_key.encode()
    path = printer_key_path(settings)
    if path.exists():
        return _read_existing_key(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    key = Fernet.generate_key()
    try:
        # O_EXCL guarantees THIS process created the file, so the mode is
        # honored atomically with no permissive window; fchmod is applied
        # before writing so creation is umask-independent as well.
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        # Another process won the create race between our exists() check
        # and our open() call -- read back the key it persisted instead of
        # generating (and clobbering) a second one.
        return _read_existing_key(path)
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, key)
    finally:
        os.close(fd)
    return key


def get_fernet(settings: Settings) -> Fernet:
    return Fernet(load_or_create_printer_key(settings))


def encrypt_secret(settings: Settings, plaintext: str) -> str:
    return get_fernet(settings).encrypt(plaintext.encode()).decode()


def decrypt_secret(settings: Settings, token: str) -> str:
    return get_fernet(settings).decrypt(token.encode()).decode()
