"""StorageBackend protocol (SPEC "Storage layer").

This is the contract every backend implements: ``local`` today, ``smb`` and
``s3`` in M3 (see SPEC M3). Keep this module free of any local-filesystem
assumptions -- it must describe behavior that SMB/S3 can also satisfy (e.g.
"fast copy" is FICLONE reflink locally, SMB2 COPYCHUNK over the network, or
S3 CopyObject remotely; callers only ever see ``copy(src, dst)``).

All implementations are **synchronous**. FastAPI request handlers must call
through ``anyio.to_thread.run_sync`` so a slow disk/network backend never
blocks the event loop; Celery task code runs in worker processes and calls
these methods directly.

Storage keys are POSIX-style paths relative to the backend's root (e.g. a
model's library root) -- never absolute, never containing ``..`` segments.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol, runtime_checkable


@dataclass(frozen=True, slots=True)
class WriteResult:
    """Outcome of a completed :meth:`StorageBackend.write` call."""

    hash: str
    size: int


@dataclass(frozen=True, slots=True)
class EntryInfo:
    """One file discovered by :meth:`StorageBackend.walk`."""

    key: str
    size: int
    mtime: datetime


@dataclass(frozen=True, slots=True)
class StatResult:
    """Outcome of a :meth:`StorageBackend.stat` call."""

    size: int
    mtime: datetime


@runtime_checkable
class StorageBackend(Protocol):
    """Synchronous storage backend contract.

    ``mtime`` values throughout (``EntryInfo``, ``StatResult``) are
    timezone-aware UTC ``datetime``s.
    """

    def write(self, key: str, chunks: Iterable[bytes]) -> WriteResult:
        """Write ``chunks`` to ``key``, hashing (blake3) as they stream by.

        Atomic: readers never observe a partially-written file at ``key``.
        On any exception raised while consuming ``chunks``, no file is left
        at ``key`` (a pre-existing file at ``key`` is left untouched) and no
        temporary artifacts remain.
        """
        ...

    def read(self, key: str, start: int = 0, end: int | None = None) -> Iterator[bytes]:
        """Yield the bytes of ``key`` from ``start`` up to ``end`` (exclusive).

        ``end=None`` reads to the end of the file. Raises
        :class:`~app.storage.errors.StorageKeyNotFound` (synchronously, not
        only once iteration begins) if ``key`` doesn't exist.
        """
        ...

    def copy(self, src: str, dst: str) -> None:
        """Copy ``src`` to ``dst``, using a backend-specific fast path when
        available (e.g. reflink), atomically publishing ``dst``.
        """
        ...

    def move(self, src: str, dst: str) -> None:
        """Move ``src`` to ``dst``."""
        ...

    def delete(self, key: str) -> None:
        """Delete ``key``."""
        ...

    def exists(self, key: str) -> bool:
        """Return whether ``key`` exists."""
        ...

    def stat(self, key: str) -> StatResult:
        """Return size/mtime metadata for ``key``."""
        ...

    def walk(self, prefix: str = "") -> Iterator[EntryInfo]:
        """Yield an :class:`EntryInfo` for every file under ``prefix``.

        Recurses into subdirectories; yields files only (never directories).
        Keys are always POSIX-style, relative to the backend root. Order is
        deterministic (sorted) so callers can rely on stable output.
        """
        ...

    def mkdirs(self, key_prefix: str) -> None:
        """Ensure the directory addressed by ``key_prefix`` exists."""
        ...
