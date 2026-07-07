"""The single parameterized storage-contract suite (SPEC M3 "Verification").

Every :class:`~app.storage.base.StorageBackend` implementation -- ``local``
today, ``smb``/``s3`` in Tasks 3-4 -- must satisfy exactly this behavior.
Tests here take only the ``storage_backend`` fixture and assert
backend-agnostic behavior; they never import or reference a concrete backend
class directly (that lives in the fixture below, and in
``tests/storage_containers.py`` for smb/s3).

Only the ``local`` param runs today. ``smb``/``s3`` skip with a clear reason
so their containers (``tests/storage_containers.py``) never start during a
normal run -- Task 3/Task 4 flip each skip to the real ``smb_backend``/
``s3_backend`` fixture as that backend lands, at which point this same suite
proves it green with no changes to the tests themselves.

The walk-ordering tests are the load-bearing ones: they pin the "sort each
directory's entries by bare name, recurse depth-first" contract from
``app/storage/base.py`` -- not a total lexicographic sort over full keys.
``test_walk_nested_sorted_files_only`` covers the common case;
``test_walk_orders_by_bare_name_not_full_key_lexicographic`` pins the
adversarial edge case ``base.py`` calls out by name (a file and a
same-prefix sibling directory sort in *opposite* relative order depending on
which of the two rules is applied) -- exactly the trap a naive S3 backend
falls into by returning ``list_objects_v2``'s flat lexicographic key order
unmodified.
"""

from datetime import UTC, datetime, timedelta

import blake3
import pytest

from app.storage.base import EntryInfo
from app.storage.errors import StorageError, StorageKeyNotFound
from app.storage.local import LocalStorageBackend


@pytest.fixture(params=["local", "smb", "s3"])
def storage_backend(request: pytest.FixtureRequest, tmp_path):
    """Yield an empty ``StorageBackend`` for each backend under test.

    ``smb``/``s3`` skip outright -- without requesting ``smb_backend``/
    ``s3_backend`` -- so neither container in ``tests/storage_containers.py``
    starts until Task 3/Task 4 removes the skip.
    """
    if request.param == "local":
        return LocalStorageBackend(tmp_path / "library")
    if request.param == "smb":
        pytest.skip("SMB backend lands in Task 3")  # remove in Task 3
    if request.param == "s3":
        pytest.skip("S3 backend lands in Task 4")  # remove in Task 4
    raise AssertionError(f"unhandled storage_backend param: {request.param!r}")


# -- write / read round trip -------------------------------------------------


def test_write_read_round_trip_and_hash(storage_backend):
    payload = b"contract" * 5000

    r = storage_backend.write("a/b.bin", [payload[:9000], payload[9000:]])

    assert r.hash == blake3.blake3(payload).hexdigest()
    assert r.size == len(payload)
    assert b"".join(storage_backend.read("a/b.bin")) == payload


def test_ranged_read(storage_backend):
    storage_backend.write("r.bin", [b"0123456789"])

    assert b"".join(storage_backend.read("r.bin", 2, 5)) == b"234"


def test_read_missing_raises_immediately(storage_backend):
    with pytest.raises(StorageKeyNotFound):
        list(storage_backend.read("nope.bin"))


# -- exists / stat ------------------------------------------------------------


def test_exists(storage_backend):
    assert storage_backend.exists("x") is False
    storage_backend.write("x", [b"y"])
    assert storage_backend.exists("x") is True


def test_stat_size_and_utc_mtime(storage_backend):
    storage_backend.write("s.bin", [b"12345"])

    st = storage_backend.stat("s.bin")

    assert st.size == 5
    assert st.mtime.tzinfo is not None
    assert abs(datetime.now(UTC) - st.mtime) < timedelta(minutes=10)


def test_stat_missing_raises(storage_backend):
    with pytest.raises(StorageKeyNotFound):
        storage_backend.stat("gone")


# -- copy / move / delete ------------------------------------------------------


def test_copy_identical_bytes(storage_backend):
    storage_backend.write("src", [b"payload"])

    storage_backend.copy("src", "dst")

    assert b"".join(storage_backend.read("dst")) == b"payload"
    assert b"".join(storage_backend.read("src")) == b"payload"


def test_move_relocates_and_removes_source(storage_backend):
    storage_backend.write("m1", [b"z"])

    storage_backend.move("m1", "m2")

    assert storage_backend.exists("m2") and not storage_backend.exists("m1")


def test_delete_then_missing_delete_raises(storage_backend):
    storage_backend.write("d", [b"z"])
    storage_backend.delete("d")

    assert not storage_backend.exists("d")
    with pytest.raises(StorageKeyNotFound):
        storage_backend.delete("d")


# -- walk -----------------------------------------------------------------


def test_walk_nested_sorted_files_only(storage_backend):
    storage_backend.write("z.bin", [b"1"])
    storage_backend.write("dir/a.bin", [b"22"])
    storage_backend.write("dir/sub/c.bin", [b"333"])

    entries = list(storage_backend.walk(""))
    keys = [e.key for e in entries]

    assert keys == ["dir/a.bin", "dir/sub/c.bin", "z.bin"]  # per-dir bare-name, depth-first
    assert all(isinstance(e, EntryInfo) for e in entries)
    by_key = {e.key: e.size for e in entries}
    assert by_key["dir/a.bin"] == 2 and by_key["dir/sub/c.bin"] == 3


def test_walk_orders_by_bare_name_not_full_key_lexicographic(storage_backend):
    """Pins the exact edge case ``app/storage/base.py`` calls out: comparing
    bare names, directory ``"ab"`` sorts before file ``"ab.bin"`` (``"ab"``
    is a prefix of ``"ab.bin"``), so ``"ab"``'s subtree is recursed into --
    and yielded -- first. But comparing the two *full keys* that produces
    (``"ab.bin"`` vs ``"ab/child.bin"``), ``"ab.bin"`` sorts first instead
    (``"."`` is 0x2E, ``"/"`` is 0x2F). A backend that naively sorts a flat
    listing of full keys (e.g. S3's ``list_objects_v2``, which returns keys
    in that same byte order) would yield these two entries in the opposite
    order from the one required here.
    """
    storage_backend.write("ab.bin", [b"1"])
    storage_backend.write("ab/child.bin", [b"22"])

    keys = [e.key for e in storage_backend.walk("")]

    assert keys == ["ab/child.bin", "ab.bin"]
    assert sorted(keys) != keys  # sanity: this really isn't a full-key lexicographic sort


def test_walk_prefix_scopes(storage_backend):
    storage_backend.write("p/one.bin", [b"1"])
    storage_backend.write("q/two.bin", [b"2"])

    assert [e.key for e in storage_backend.walk("p")] == ["p/one.bin"]


def test_walk_missing_prefix_yields_nothing(storage_backend):
    assert list(storage_backend.walk("absent")) == []


# -- write atomicity ------------------------------------------------------


def test_write_atomic_no_partial_on_mid_write_exception(storage_backend):
    def chunks():
        yield b"first"
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        storage_backend.write("atomic.bin", chunks())

    assert not storage_backend.exists("atomic.bin")


def test_write_preserves_existing_on_mid_write_exception(storage_backend):
    storage_backend.write("keep.bin", [b"original"])

    def chunks():
        yield b"new"
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        storage_backend.write("keep.bin", chunks())

    assert b"".join(storage_backend.read("keep.bin")) == b"original"


# -- key safety -----------------------------------------------------------


@pytest.mark.parametrize("bad", ["", ".", "..", "/abs", "a/../b", "a\\b"])
def test_rejects_unsafe_keys(storage_backend, bad):
    with pytest.raises(StorageError):
        storage_backend.write(bad, [b"x"])
