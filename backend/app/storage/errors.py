"""Typed errors for the storage layer (SPEC "Storage layer").

Kept backend-agnostic: every :class:`~app.storage.base.StorageBackend`
implementation (local, and SMB/S3 in M3) raises these same types so callers
never need to know which backend they're talking to.
"""


class StorageError(Exception):
    """Base class for storage-layer errors (bad keys, backend failures)."""


class StorageKeyNotFound(StorageError):
    """Raised when an operation references a key that doesn't exist.

    Covers ``read``/``stat``/``delete``/``copy``/``move`` (source side).
    """

    def __init__(self, key: str) -> None:
        super().__init__(f"storage key not found: {key!r}")
        self.key = key
