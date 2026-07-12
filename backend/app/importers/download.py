"""Stream a remote file straight to the upload spool, blake3-hashing while
it streams -- the importer analog of app.api.uploads' tee-to-spool loop
(surface map §3a), but reading an httpx streaming response instead of an
ASGI request body. Runs in the worker's SYNC world. ``_download_client`` is
the ONE construction seam tests monkeypatch with an httpx.MockTransport
(Global Constraints M5 EXCEPTION); the default gate makes no real network
call.

``stage_zip_member`` is the same spool+blake3 machinery's sibling for
``app.importers.archives``' zip extraction: tees an already-open zip
member's bytes to a NEW spool file instead of an HTTP response body."""

from __future__ import annotations

import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path

import httpx
from blake3 import blake3

from app.config import Settings
from app.models.enums import BlobFormat, BlobKind
from app.services import layout, spool

_CHUNK_SIZE = 1024 * 1024  # 1 MiB, matching store_to_backend's read chunking
_TIMEOUT = httpx.Timeout(30.0, read=300.0)
_USER_AGENT = "3d-model-manager/1.0 (+https://github.com/metril/3d-model-manager)"


@dataclass(frozen=True)
class StagedFile:
    token: uuid.UUID
    spool_path: Path
    blob_hash: str
    size: int
    rel_path: str
    kind: BlobKind
    format_: BlobFormat


def _download_client() -> httpx.Client:
    return httpx.Client(
        follow_redirects=True, timeout=_TIMEOUT, headers={"User-Agent": _USER_AGENT}
    )


def stream_remote_to_spool(
    settings: Settings, *, url: str, rel_path: str, headers: dict[str, str] | None = None
) -> StagedFile:
    spool.ensure_spool_dir(settings)
    token = uuid.uuid4()
    path = spool.spool_path(settings, token)
    hasher = blake3()
    size = 0
    try:
        with _download_client() as client, client.stream("GET", url, headers=headers or {}) as resp:
            resp.raise_for_status()
            with path.open("wb") as fh:
                for chunk in resp.iter_bytes(_CHUNK_SIZE):
                    if not chunk:
                        continue
                    hasher.update(chunk)
                    size += len(chunk)
                    fh.write(chunk)
    except BaseException:
        path.unlink(missing_ok=True)  # never orphan a spool file on a failed stream
        raise
    if size == 0:
        path.unlink(missing_ok=True)
        raise ValueError(f"remote file {rel_path!r} was empty")
    kind, format_ = layout.infer_blob_kind_format(rel_path)
    return StagedFile(
        token=token,
        spool_path=path,
        blob_hash=hasher.hexdigest(),
        size=size,
        rel_path=rel_path,
        kind=kind,
        format_=format_,
    )


def stage_zip_member(
    settings: Settings, zf: zipfile.ZipFile, info: zipfile.ZipInfo, rel_path: str
) -> StagedFile:
    """Sibling of ``stream_remote_to_spool`` for ``app.importers.archives``:
    tees one already-open zip member to a NEW spool file, blake3-hashing
    while it streams -- ``zf.open(info)`` + chunked ``.read()`` rather than
    an httpx response, but otherwise the exact same spool+hash machinery
    (own token, own spool path) so the result is a first-class
    ``StagedFile`` indistinguishable from a directly-downloaded one.
    Constant memory: never reads the whole member into memory at once, even
    though ``zipfile`` itself has no streaming ``.iter_bytes`` equivalent.

    Unlike ``stream_remote_to_spool``, a zero-byte member is NOT an error --
    a legitimate archive can contain empty placeholder files, whereas a
    zero-byte HTTP download is a strong signal of a broken remote URL.
    """
    spool.ensure_spool_dir(settings)
    token = uuid.uuid4()
    path = spool.spool_path(settings, token)
    hasher = blake3()
    size = 0
    try:
        with zf.open(info) as member, path.open("wb") as fh:
            while chunk := member.read(_CHUNK_SIZE):
                hasher.update(chunk)
                size += len(chunk)
                fh.write(chunk)
    except BaseException:
        path.unlink(missing_ok=True)  # never orphan a spool file on a failed stream
        raise
    kind, format_ = layout.infer_blob_kind_format(rel_path)
    return StagedFile(
        token=token,
        spool_path=path,
        blob_hash=hasher.hexdigest(),
        size=size,
        rel_path=rel_path,
        kind=kind,
        format_=format_,
    )
