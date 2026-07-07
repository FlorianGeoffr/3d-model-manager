"""S3-specific behavior not covered by the backend-agnostic contract suite
(``tests/test_storage_contract.py``): multipart upload (including abort on a
mid-stream failure), the flat-listing-to-tree ``walk()`` reconstruction, HEAD
(not ETag) as the source of ``stat()`` truth, and using the ``CopyObject``
API (not a read+write round trip) for ``copy()``.
"""

from __future__ import annotations

import os

import pytest

from app.storage.s3 import _MPU_THRESHOLD, S3StorageBackend


def test_multipart_upload_for_large_object(s3_backend: S3StorageBackend):
    payload = os.urandom(_MPU_THRESHOLD + 1024)  # forces the MPU path

    r = s3_backend.write("big.bin", [payload])

    assert r.size == len(payload)
    assert b"".join(s3_backend.read("big.bin")) == payload


def test_walk_reconstructs_per_dir_order_not_lexicographic(s3_backend: S3StorageBackend):
    # "ab.bin" vs sibling dir "ab/child.bin": full-key lexicographic would put
    # ab.bin first ('.' < '/'); the per-dir bare-name contract puts the "ab"
    # subtree first because bare "ab" < bare "ab.bin".
    s3_backend.write("ab.bin", [b"1"])
    s3_backend.write("ab/child.bin", [b"2"])

    assert [e.key for e in s3_backend.walk("")] == ["ab/child.bin", "ab.bin"]


def test_stat_uses_head_not_etag_identity(s3_backend: S3StorageBackend):
    s3_backend.write("h.bin", [b"12345"])

    assert s3_backend.stat("h.bin").size == 5  # size from HEAD; ETag never used as identity


def test_mid_write_exception_leaves_no_object(s3_backend: S3StorageBackend):
    def chunks():
        yield b"x"
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        s3_backend.write("never.bin", chunks())

    assert not s3_backend.exists("never.bin")


def test_mid_write_exception_during_mpu_aborts_and_leaves_no_object(s3_backend: S3StorageBackend):
    """Same atomicity guarantee as the small-object path, but forced through
    the multipart branch: a failure partway through a large upload must abort
    the in-progress MPU (no dangling parts, no partial object visible).
    """

    def chunks():
        yield os.urandom(_MPU_THRESHOLD + 1024)  # crosses the MPU threshold
        yield os.urandom(1024)
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        s3_backend.write("never-big.bin", chunks())

    assert not s3_backend.exists("never-big.bin")
    # No multipart upload for this key was left dangling on the bucket --
    # abort_multipart_upload actually ran rather than just orphaning parts.
    pending = s3_backend._s3.list_multipart_uploads(
        Bucket=s3_backend._c.bucket, Prefix=s3_backend._obj("never-big.bin")
    )
    assert not pending.get("Uploads")


def test_copy_uses_copy_object_not_read_then_write(s3_backend: S3StorageBackend, monkeypatch):
    s3_backend.write("src.bin", [b"payload"])

    calls: list[str] = []
    real_copy_object = s3_backend._s3.copy_object
    real_get_object = s3_backend._s3.get_object
    real_put_object = s3_backend._s3.put_object

    def _tracked(name, real):
        def _call(**kwargs):
            calls.append(name)
            return real(**kwargs)

        return _call

    monkeypatch.setattr(s3_backend._s3, "copy_object", _tracked("copy_object", real_copy_object))
    monkeypatch.setattr(s3_backend._s3, "get_object", _tracked("get_object", real_get_object))
    monkeypatch.setattr(s3_backend._s3, "put_object", _tracked("put_object", real_put_object))

    s3_backend.copy("src.bin", "dst.bin")

    # copy() must go through CopyObject alone -- no GetObject+PutObject
    # round trip through this process.
    assert calls == ["copy_object"]
    assert b"".join(s3_backend.read("dst.bin")) == b"payload"
