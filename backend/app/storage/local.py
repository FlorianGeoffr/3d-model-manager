"""Local filesystem :class:`~app.storage.base.StorageBackend` (SPEC "Storage
layer").

Atomicity: both ``write`` and ``copy`` stage their result in a temp file in
the *same directory* as the final destination, then publish it with a single
``os.replace`` -- atomic because temp file and destination share a
filesystem. On any failure the temp file is removed and the exception
re-raised; a pre-existing file at the destination is never touched until the
replace succeeds.

Fast copy: ``copy`` first attempts an FICLONE reflink (near-instant,
copy-on-write clone -- supported by btrfs/XFS/etc, not by e.g. ext4/tmpfs)
via ``fcntl.ioctl``; on ``OSError`` (unsupported filesystem, cross-device,
...) it falls back to ``shutil.copyfile``. Both paths write into the same
staging temp file before the atomic replace.
"""

from __future__ import annotations

import fcntl
import os
import shutil
import tempfile
from collections.abc import Iterable, Iterator
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

from blake3 import blake3

from app.storage.base import EntryInfo, StatResult, WriteResult
from app.storage.errors import StorageError, StorageKeyNotFound

_READ_CHUNK_SIZE = 1024 * 1024  # 1 MiB

# ``fcntl`` doesn't expose FICLONE as a named constant on every Python
# build (CPython's fcntl module only wraps a fixed constant list). It's a
# fixed Linux ioctl request code (see <linux/fs.h>: `_IOW(0x94, 9, int)`),
# identical across x86_64/aarch64, so fall back to the literal value.
try:
    _FICLONE = fcntl.FICLONE
except AttributeError:  # pragma: no cover - depends on platform/python build
    _FICLONE = 0x40049409


def _utc(timestamp: float) -> datetime:
    return datetime.fromtimestamp(timestamp, tz=UTC)


class LocalStorageBackend:
    """Stores files under a single ``root`` directory on local disk."""

    def __init__(self, root: Path | str) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    # -- key safety -----------------------------------------------------

    def _resolve(self, key: str) -> Path:
        """Resolve ``key`` to an absolute path under ``root``.

        Rejects (``StorageError``) absolute keys, ``..`` segments, empty
        keys, and backslashes, then verifies the resolved path -- following
        any symlinks -- actually stays under ``root`` (symlink escape).
        """
        if not key:
            raise StorageError("storage key must not be empty")
        if "\\" in key:
            raise StorageError(f"storage key must use POSIX separators: {key!r}")

        pure = PurePosixPath(key)
        if pure.is_absolute():
            raise StorageError(f"storage key must be relative: {key!r}")
        if ".." in pure.parts:
            raise StorageError(f"storage key must not contain '..': {key!r}")

        candidate = (self.root / pure).resolve()
        if candidate != self.root and self.root not in candidate.parents:
            raise StorageError(f"storage key escapes storage root: {key!r}")
        return candidate

    def _resolve_prefix(self, prefix: str) -> Path:
        """Like :meth:`_resolve` but allows ``""`` to mean the root itself."""
        if prefix == "":
            return self.root
        return self._resolve(prefix)

    # -- write / read -----------------------------------------------------

    def write(self, key: str, chunks: Iterable[bytes]) -> WriteResult:
        dest = self._resolve(key)
        dest.parent.mkdir(parents=True, exist_ok=True)

        tmp_fd, tmp_name = tempfile.mkstemp(dir=dest.parent, prefix=f".{dest.name}.", suffix=".tmp")
        tmp_path = Path(tmp_name)
        try:
            hasher = blake3()
            size = 0
            with os.fdopen(tmp_fd, "wb") as tmp_file:
                for chunk in chunks:
                    tmp_file.write(chunk)
                    hasher.update(chunk)
                    size += len(chunk)
            os.replace(tmp_path, dest)
        except BaseException:
            tmp_path.unlink(missing_ok=True)
            raise
        return WriteResult(hash=hasher.hexdigest(), size=size)

    def read(self, key: str, start: int = 0, end: int | None = None) -> Iterator[bytes]:
        path = self._resolve(key)
        if not path.is_file():
            raise StorageKeyNotFound(key)
        return self._read_range(path, start, end)

    @staticmethod
    def _read_range(path: Path, start: int, end: int | None) -> Iterator[bytes]:
        with path.open("rb") as f:
            f.seek(start)
            remaining = None if end is None else max(0, end - start)
            while remaining is None or remaining > 0:
                read_size = (
                    _READ_CHUNK_SIZE if remaining is None else min(_READ_CHUNK_SIZE, remaining)
                )
                chunk = f.read(read_size)
                if not chunk:
                    break
                if remaining is not None:
                    remaining -= len(chunk)
                yield chunk

    # -- stat / exists / delete -------------------------------------------

    def stat(self, key: str) -> StatResult:
        path = self._resolve(key)
        if not path.is_file():
            raise StorageKeyNotFound(key)
        st = path.stat()
        return StatResult(size=st.st_size, mtime=_utc(st.st_mtime))

    def exists(self, key: str) -> bool:
        return self._resolve(key).is_file()

    def delete(self, key: str) -> None:
        path = self._resolve(key)
        try:
            path.unlink()
        except FileNotFoundError as e:
            raise StorageKeyNotFound(key) from e

    # -- move / copy -------------------------------------------------------

    def move(self, src: str, dst: str) -> None:
        src_path = self._resolve(src)
        dst_path = self._resolve(dst)
        if not src_path.is_file():
            raise StorageKeyNotFound(src)
        dst_path.parent.mkdir(parents=True, exist_ok=True)
        os.replace(src_path, dst_path)

    def copy(self, src: str, dst: str) -> None:
        src_path = self._resolve(src)
        dst_path = self._resolve(dst)
        if not src_path.is_file():
            raise StorageKeyNotFound(src)
        dst_path.parent.mkdir(parents=True, exist_ok=True)

        tmp_fd, tmp_name = tempfile.mkstemp(
            dir=dst_path.parent, prefix=f".{dst_path.name}.", suffix=".tmp"
        )
        os.close(tmp_fd)
        tmp_path = Path(tmp_name)
        try:
            if not self._try_reflink(src_path, tmp_path):
                shutil.copyfile(src_path, tmp_path)
            os.replace(tmp_path, dst_path)
        except BaseException:
            tmp_path.unlink(missing_ok=True)
            raise

    @staticmethod
    def _try_reflink(src_path: Path, tmp_path: Path) -> bool:
        """Attempt an FICLONE reflink copy of ``src_path`` onto ``tmp_path``.

        Returns ``True`` on success, ``False`` if the filesystem doesn't
        support it (caller falls back to a byte-for-byte copy).
        """
        with open(src_path, "rb") as src_f, open(tmp_path, "wb") as dst_f:
            try:
                fcntl.ioctl(dst_f.fileno(), _FICLONE, src_f.fileno())
                return True
            except OSError:
                return False

    # -- walk / mkdirs -------------------------------------------------------

    def walk(self, prefix: str = "") -> Iterator[EntryInfo]:
        start_dir = self._resolve_prefix(prefix)
        return self._walk_dir(start_dir)

    def _walk_dir(self, dir_path: Path) -> Iterator[EntryInfo]:
        if not dir_path.is_dir():
            return
        for entry in self._scandir_sorted(dir_path):
            entry_path = Path(entry.path)
            if entry.is_dir(follow_symlinks=False):
                yield from self._walk_dir(entry_path)
            elif entry.is_file(follow_symlinks=False):
                st = entry.stat(follow_symlinks=False)
                key = entry_path.relative_to(self.root).as_posix()
                yield EntryInfo(key=key, size=st.st_size, mtime=_utc(st.st_mtime))

    @staticmethod
    def _scandir_sorted(dir_path: Path) -> list[os.DirEntry]:
        with os.scandir(dir_path) as it:
            return sorted(it, key=lambda e: e.name)

    def mkdirs(self, key_prefix: str) -> None:
        self._resolve_prefix(key_prefix).mkdir(parents=True, exist_ok=True)
