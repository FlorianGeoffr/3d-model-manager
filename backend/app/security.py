"""Argon2id password hashing (SPEC requirement 1: single admin login).

Uses argon2-cffi's ``PasswordHasher`` with its library defaults. Those
defaults use ``Type.ID`` (argon2id) already, so nothing further needs to be
configured to satisfy "argon2id hash/verify (argon2-cffi defaults)".
"""

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

_hasher = PasswordHasher()

# Hashed once at import time so a login attempt for a username that doesn't
# exist can still run a real argon2 verification against *something*.
# Without this, a bad-username request would return almost instantly while
# a bad-password request pays the full hashing cost, leaking which case
# occurred via response timing (see app.api.auth.login).
DUMMY_HASH = _hasher.hash("tdmm-dummy-password-for-timing-safety")


def hash_password(password: str) -> str:
    """Hash ``password`` with argon2id."""
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    """Return whether ``password`` matches ``password_hash``. Never raises."""
    try:
        return _hasher.verify(password_hash, password)
    except (VerificationError, InvalidHashError):
        return False
