"""Stream a remote file straight to the upload spool, blake3-hashing while
it streams -- the importer analog of app.api.uploads' tee-to-spool loop
(surface map §3a), but reading an httpx streaming response instead of an
ASGI request body. Runs in the worker's SYNC world. ``_download_client`` is
the ONE construction seam tests monkeypatch with an httpx.MockTransport
(Global Constraints M5 EXCEPTION); the default gate makes no real network
call."""

from __future__ import annotations

import uuid
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
