"""Local filesystem ``StorageBackend`` (SPEC "Storage layer").

Covers atomic hash-verifying writes, ranged reads, reflink-or-fallback copy,
move/delete/exists/stat, recursive walk, and key-safety rejection (absolute
paths, ``..`` traversal, backslashes, empty keys, symlink escape).
"""

import fcntl
import os
from datetime import timedelta
from pathlib import Path

import blake3
import pytest

from app.storage.errors import StorageError, StorageKeyNotFound
from app.storage.local import LocalStorageBackend


@pytest.fixture
def backend(tmp_path: Path) -> LocalStorageBackend:
    return LocalStorageBackend(tmp_path / "library")


# -- write / read round trip -------------------------------------------------


def test_write_read_round_trip_and_correct_hash(backend: LocalStorageBackend) -> None:
    payload = b"hello world" * 1000

    result = backend.write("models/thing.stl", [payload[:5000], payload[5000:]])

    assert result.hash == blake3.blake3(payload).hexdigest()
    assert result.size == len(payload)
    assert b"".join(backend.read("models/thing.stl")) == payload


def test_read_yields_1mib_chunks(backend: LocalStorageBackend) -> None:
    payload = os.urandom(3 * 1024 * 1024 + 123)
    backend.write("big.bin", [payload])

    chunks = list(backend.read("big.bin"))

    assert len(chunks[0]) == 1024 * 1024
    assert len(chunks[1]) == 1024 * 1024
    assert b"".join(chunks) == payload


def test_read_with_start_and_end_range(backend: LocalStorageBackend) -> None:
    backend.write("f.bin", [b"0123456789"])

    assert b"".join(backend.read("f.bin", start=2, end=5)) == b"234"
    assert b"".join(backend.read("f.bin", start=7)) == b"789"
    assert b"".join(backend.read("f.bin", start=0, end=0)) == b""


def test_read_missing_key_raises_immediately(backend: LocalStorageBackend) -> None:
    with pytest.raises(StorageKeyNotFound):
        backend.read("missing.bin")


# -- write atomicity ----------------------------------------------------------


def test_write_atomicity_no_partial_file_on_mid_write_exception(
    backend: LocalStorageBackend,
) -> None:
    def bad_chunks():
        yield b"partial-data"
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        backend.write("thing.bin", bad_chunks())

    assert not (backend.root / "thing.bin").exists()
    assert list(backend.root.iterdir()) == []  # no leftover temp file


def test_write_atomicity_preserves_existing_file_on_mid_write_exception(
    backend: LocalStorageBackend,
) -> None:
    backend.write("thing.bin", [b"original"])

    def bad_chunks():
        yield b"replacement"
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        backend.write("thing.bin", bad_chunks())

    assert b"".join(backend.read("thing.bin")) == b"original"
    assert [p.name for p in backend.root.iterdir()] == ["thing.bin"]  # no leftover temp file


# -- stat / exists / delete ---------------------------------------------------


def test_stat_returns_size_and_utc_mtime(backend: LocalStorageBackend) -> None:
    backend.write("f.bin", [b"hello"])

    result = backend.stat("f.bin")

    assert result.size == 5
    assert result.mtime.tzinfo is not None
    assert result.mtime.utcoffset() == timedelta(0)


def test_stat_missing_key_raises(backend: LocalStorageBackend) -> None:
    with pytest.raises(StorageKeyNotFound):
        backend.stat("missing.bin")


def test_exists_true_and_false(backend: LocalStorageBackend) -> None:
    backend.write("f.bin", [b"x"])

    assert backend.exists("f.bin") is True
    assert backend.exists("missing.bin") is False


def test_delete_removes_file(backend: LocalStorageBackend) -> None:
    backend.write("f.bin", [b"x"])

    backend.delete("f.bin")

    assert backend.exists("f.bin") is False


def test_delete_missing_key_raises(backend: LocalStorageBackend) -> None:
    with pytest.raises(StorageKeyNotFound):
        backend.delete("missing.bin")


# -- move -----------------------------------------------------------------


def test_move_relocates_file_and_removes_source(backend: LocalStorageBackend) -> None:
    backend.write("src/f.bin", [b"payload"])

    backend.move("src/f.bin", "dst/f.bin")

    assert backend.exists("src/f.bin") is False
    assert b"".join(backend.read("dst/f.bin")) == b"payload"


def test_move_missing_src_raises(backend: LocalStorageBackend) -> None:
    with pytest.raises(StorageKeyNotFound):
        backend.move("missing.bin", "dst.bin")


# -- copy -----------------------------------------------------------------


def test_copy_produces_identical_bytes(backend: LocalStorageBackend) -> None:
    payload = os.urandom(64 * 1024)
    backend.write("src.bin", [payload])

    backend.copy("src.bin", "dst.bin")

    assert b"".join(backend.read("dst.bin")) == payload
    assert b"".join(backend.read("src.bin")) == payload  # source untouched


def test_copy_leaves_no_temp_file_behind(backend: LocalStorageBackend) -> None:
    backend.write("src.bin", [b"data"])

    backend.copy("src.bin", "dst.bin")

    assert sorted(p.name for p in backend.root.iterdir()) == ["dst.bin", "src.bin"]


def test_copy_falls_back_to_shutil_when_ficlone_unsupported(
    backend: LocalStorageBackend, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = os.urandom(64 * 1024)
    backend.write("src.bin", [payload])

    def _raise(*args: object, **kwargs: object) -> None:
        raise OSError("FICLONE not supported on this filesystem")

    monkeypatch.setattr(fcntl, "ioctl", _raise)

    backend.copy("src.bin", "dst.bin")

    assert b"".join(backend.read("dst.bin")) == payload


def test_copy_missing_src_raises(backend: LocalStorageBackend) -> None:
    with pytest.raises(StorageKeyNotFound):
        backend.copy("missing.bin", "dst.bin")


# -- walk -----------------------------------------------------------------


def test_walk_lists_nested_files_with_sizes(backend: LocalStorageBackend) -> None:
    backend.write("a.bin", [b"12345"])
    backend.write("sub/b.bin", [b"1234567890"])
    backend.write("sub/deeper/c.bin", [b"x"])

    entries = list(backend.walk())
    by_key = {e.key: e for e in entries}

    assert set(by_key) == {"a.bin", "sub/b.bin", "sub/deeper/c.bin"}
    assert by_key["a.bin"].size == 5
    assert by_key["sub/b.bin"].size == 10
    assert by_key["sub/deeper/c.bin"].size == 1
    assert all(e.mtime.tzinfo is not None for e in entries)


def test_walk_keys_are_posix_and_sorted(backend: LocalStorageBackend) -> None:
    backend.write("b.bin", [b"1"])
    backend.write("a.bin", [b"1"])
    backend.write("sub/z.bin", [b"1"])

    keys = [e.key for e in backend.walk()]

    assert keys == sorted(keys)
    assert all("\\" not in k for k in keys)


def test_walk_with_prefix_scopes_to_subdirectory(backend: LocalStorageBackend) -> None:
    backend.write("sub/a.bin", [b"1"])
    backend.write("other/b.bin", [b"1"])

    keys = [e.key for e in backend.walk("sub")]

    assert keys == ["sub/a.bin"]


def test_walk_missing_prefix_yields_nothing(backend: LocalStorageBackend) -> None:
    assert list(backend.walk("does/not/exist")) == []


def test_walk_ignores_directories_as_entries(backend: LocalStorageBackend) -> None:
    backend.write("sub/a.bin", [b"1"])

    keys = [e.key for e in backend.walk()]

    assert "sub" not in keys


# -- mkdirs -----------------------------------------------------------------


def test_mkdirs_creates_nested_directories(backend: LocalStorageBackend) -> None:
    backend.mkdirs("a/b/c")

    assert (backend.root / "a" / "b" / "c").is_dir()


def test_mkdirs_is_idempotent(backend: LocalStorageBackend) -> None:
    backend.mkdirs("a/b")
    backend.mkdirs("a/b")

    assert (backend.root / "a" / "b").is_dir()


# -- key safety -----------------------------------------------------------


@pytest.mark.parametrize(
    "bad_key",
    [
        "/etc/passwd",
        "../escape.bin",
        "a/../../escape.bin",
        "a\\b.bin",
        "",
    ],
)
def test_write_rejects_unsafe_keys(backend: LocalStorageBackend, bad_key: str) -> None:
    with pytest.raises(StorageError):
        backend.write(bad_key, [b"x"])


def test_read_rejects_traversal_key(backend: LocalStorageBackend) -> None:
    with pytest.raises(StorageError):
        backend.read("../escape.bin")


def test_stat_rejects_traversal_key(backend: LocalStorageBackend) -> None:
    with pytest.raises(StorageError):
        backend.stat("../escape.bin")


def test_exists_rejects_traversal_key(backend: LocalStorageBackend) -> None:
    with pytest.raises(StorageError):
        backend.exists("../escape.bin")


def test_delete_rejects_traversal_key(backend: LocalStorageBackend) -> None:
    with pytest.raises(StorageError):
        backend.delete("../escape.bin")


def test_copy_rejects_traversal_key_on_either_side(backend: LocalStorageBackend) -> None:
    backend.write("src.bin", [b"x"])

    with pytest.raises(StorageError):
        backend.copy("../escape.bin", "dst.bin")
    with pytest.raises(StorageError):
        backend.copy("src.bin", "../escape.bin")


def test_move_rejects_traversal_key(backend: LocalStorageBackend) -> None:
    with pytest.raises(StorageError):
        backend.move("../escape.bin", "dst.bin")


def test_mkdirs_rejects_traversal_key(backend: LocalStorageBackend) -> None:
    with pytest.raises(StorageError):
        backend.mkdirs("../escape")


def test_resolved_symlink_escaping_root_is_rejected(tmp_path: Path) -> None:
    library_root = tmp_path / "library"
    library_root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (library_root / "escape").symlink_to(outside, target_is_directory=True)

    backend = LocalStorageBackend(library_root)

    with pytest.raises(StorageError):
        backend.write("escape/evil.bin", [b"x"])
