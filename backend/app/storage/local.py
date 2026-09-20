"""Local filesystem :class:`~app.storage.base.StorageBackend` (SPEC "Storage
layer").

Atomicity: both ``write`` and ``copy`` stage their result in a temp file in
the *same directory* as the final destination -- named with a distinctive
``.tdmm-tmp-`` prefix so ``walk`` can filter out any in-flight or
crash-abandoned staging files -- then ``fsync`` it and publish it with a
single ``os.replace``, atomic because temp file and destination share a
filesystem. On any failure the temp file is removed and the exception
re-raised; a pre-existing file at the destination is never touched until the
replace succeeds. (Fsyncing the *parent directory* to durably persist the
rename itself is deliberately out of scope for M1 -- an acceptable,
documented tradeoff; see the comment in ``write()``.)

Fast copy: ``copy`` first attempts an FICLONE reflink (near-instant,
copy-on-write clone -- supported by btrfs/XFS/etc, not by e.g. ext4/tmpfs)
via ``fcntl.ioctl``; on ``OSError`` (unsupported filesystem, cross-device,
...) it falls back to ``shutil.copyfile``. Both paths write into the same
staging temp file before the atomic replace.
"""

from __future__ import annotations

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

# Prefix for staging temp files created by write()/copy() so walk() can filter
# them out (e.g. if a walk races an in-flight write, or a crash leaves one
# behind) and so they're easy to recognize/clean up by hand.
_TMP_PREFIX = ".tdmm-tmp-"

try:
    import fcntl

    try:
        _FICLONE = fcntl.FICLONE
    except AttributeError:  # pragma: no cover - depends on platform/python build
        _FICLONE = 0x40049409
except ImportError:  # pragma: no cover - Windows fallback
    fcntl = None
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

        Rejects (``StorageError``) absolute keys, ``..`` segments, empty or
        current-directory keys (``""``/``"."``, which would otherwise resolve
        to ``root`` itself), backslashes, and any component in the
        ``.tdmm-tmp-`` staging namespace, then verifies the resolved path --
        following any symlinks -- actually stays under ``root`` (symlink
        escape).
        """
        if not key:
            raise StorageError("storage key must not be empty")
        if "\\" in key:
            raise StorageError(f"storage key must use POSIX separators: {key!r}")

        pure = PurePosixPath(key)
        if pure.is_absolute():
            raise StorageError(f"storage key must be relative: {key!r}")
        if pure.parts == ():
            # Covers "" (already caught above) and "." -- both would
            # otherwise resolve to `root` itself, which is never a valid
            # file key.
            raise StorageError(f"storage key must not resolve to the storage root: {key!r}")
        if ".." in pure.parts:
            raise StorageError(f"storage key must not contain '..': {key!r}")
        if any(part.startswith(_TMP_PREFIX) for part in pure.parts):
            # Reserve the whole `.tdmm-tmp-*` namespace for write()/copy()'s
            # own staging files, at any path depth. `walk()` filters this
            # prefix out on the way back, so a user-writable key inside it
            # would be a file the scanner (SPEC M3) can never see -- looking
            # like storage that's missing/untracked even though it's sitting
            # right there on disk.
            raise StorageError(
                f"storage key must not use the reserved '{_TMP_PREFIX}' prefix: {key!r}"
            )

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

        tmp_fd, tmp_name = tempfile.mkstemp(
            dir=dest.parent, prefix=f"{_TMP_PREFIX}{dest.name}.", suffix=".tmp"
        )
        tmp_path = Path(tmp_name)
        try:
            # `mkstemp` always creates the temp file mode 0600, ignoring
            # umask, regardless of what the destination should end up as
            # (Task 9 e2e finding: library files are never secrets -- SPEC
            # requirement 3 explicitly wants a "human-readable tree" a host
            # operator can inspect/back up directly -- so relax this back to
            # a normal 0644 before the atomic replace below publishes it).
            if hasattr(os, "fchmod"):
                os.fchmod(tmp_fd, 0o644)
            hasher = blake3()
            size = 0
            with os.fdopen(tmp_fd, "wb") as tmp_file:
                for chunk in chunks:
                    tmp_file.write(chunk)
                    hasher.update(chunk)
                    size += len(chunk)
                # Durability: make sure the file's data is actually on disk
                # before the atomic rename publishes it, so a crash right
                # after `write()` returns can't leave `dest` pointing at a
                # zero-length or truncated file. (Fsyncing the *parent
                # directory* too -- to durably persist the rename entry
                # itself -- is deliberately out of scope for M1: an
                # acceptable, documented tradeoff given the target
                # single-disk local deployment; revisit if that changes.)
                tmp_file.flush()
                os.fsync(tmp_file.fileno())
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
        except IsADirectoryError as e:
            raise StorageError(f"storage key is a directory, not a file: {key!r}") from e

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
            dir=dst_path.parent, prefix=f"{_TMP_PREFIX}{dst_path.name}.", suffix=".tmp"
        )
        # See the matching comment in write(): mkstemp forces 0600 regardless
        # of umask; relax it back to 0644 before this temp file is published.
        if hasattr(os, "fchmod"):
            os.fchmod(tmp_fd, 0o644)
        os.close(tmp_fd)
        tmp_path = Path(tmp_name)
        try:
            if not self._try_reflink(src_path, tmp_path):
                # Fallback: copy via an open fd onto the temp file so we can
                # fsync it before the atomic replace (see write()'s comment
                # on the deliberate, documented M1 tradeoff of not also
                # fsyncing the parent directory).
                with open(src_path, "rb") as src_f, open(tmp_path, "wb") as dst_f:
                    shutil.copyfileobj(src_f, dst_f)
                    dst_f.flush()
                    os.fsync(dst_f.fileno())
            os.replace(tmp_path, dst_path)
        except BaseException:
            tmp_path.unlink(missing_ok=True)
            raise

    @staticmethod
    def _try_reflink(src_path: Path, tmp_path: Path) -> bool:
        """Attempt an FICLONE reflink copy of ``src_path`` onto ``tmp_path``.

        Returns ``True`` on success (fsynced -- durable on disk before the
        caller's atomic replace), ``False`` if the filesystem doesn't
        support it (caller falls back to a byte-for-byte copy).
        """
        if fcntl is None:
            return False
        with open(src_path, "rb") as src_f, open(tmp_path, "wb") as dst_f:
            try:
                fcntl.ioctl(dst_f.fileno(), _FICLONE, src_f.fileno())
            except OSError:
                return False
            dst_f.flush()
            os.fsync(dst_f.fileno())
            return True

    # -- walk / mkdirs -------------------------------------------------------

    def walk(self, prefix: str = "") -> Iterator[EntryInfo]:
        start_dir = self._resolve_prefix(prefix)
        return self._walk_dir(start_dir)

    def _walk_dir(self, dir_path: Path) -> Iterator[EntryInfo]:
        if not dir_path.is_dir():
            return
        for entry in self._scandir_sorted(dir_path):
            if entry.name.startswith(_TMP_PREFIX):
                # In-flight write()/copy() staging file (or one left behind
                # by a crash before cleanup ran) -- never a real key.
                continue
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
