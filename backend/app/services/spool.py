"""Upload spool directory (SPEC "Upload flow", Task 6 interface decisions).

Raw upload bytes land at ``{data_dir}/spool/{token}`` while being teed to
blake3, before any blob/file row exists yet. The token used for a given
upload's spool filename is the SAME uuid later used as the ``jobs.id`` for
the ``store_to_backend`` job created once the upload completes (see
``app.api.uploads``) -- so a job's spool file can always be found again from
just the job id, e.g. for ``POST /api/jobs/{id}/retry``.
"""

from __future__ import annotations

import uuid
from pathlib import Path

import anyio
from blake3 import blake3
from fastapi import HTTPException, Request, status

from app.config import Settings

SPOOL_DIRNAME = "spool"


def spool_dir(settings: Settings) -> Path:
    """The spool directory's path (not guaranteed to exist -- see
    ``ensure_spool_dir``).
    """
    return Path(settings.data_dir) / SPOOL_DIRNAME


def ensure_spool_dir(settings: Settings) -> Path:
    """Create the spool directory if missing; idempotent.

    Called from the app lifespan on startup, and defensively before every
    upload (some test setups exercise the API without running the lifespan).
    """
    directory = spool_dir(settings)
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def spool_path(settings: Settings, token: uuid.UUID | str) -> Path:
    """The path a given upload token's spool file lives (or would live) at."""
    return spool_dir(settings) / str(token)


async def stream_to_spool(
    request: Request, settings: Settings, *, max_size: int | None = None
) -> tuple[uuid.UUID, Path, str, int]:
    """Tee ``request``'s raw streamed body to a fresh spool file while
    hashing it with blake3, returning ``(token, path, blob_hash, size)``.

    Shared by ``PUT /api/uploads`` and ``POST /models/{slug}/cover`` -- both
    raw-body streamed ingests that spool-then-hash before touching any
    blob/file row (R13a). ``max_size``, if given, aborts (413) as soon as
    the streamed byte count exceeds it, without buffering past the limit.

    On success, the caller owns cleanup of the returned spool file (once a
    job is dispatched for it, that job's own lifecycle takes over: deleted
    on success, kept on failure for retry). On failure raised HERE
    (including the 413 above), this function has already unlinked whatever
    it wrote -- callers only need their own cleanup path for failures that
    happen AFTER this returns (see ``app.api.uploads.upload_file``).
    """
    await anyio.to_thread.run_sync(ensure_spool_dir, settings)
    token = uuid.uuid4()
    path = spool_path(settings, token)
    hasher = blake3()
    size = 0
    try:
        fh = await anyio.to_thread.run_sync(path.open, "wb")
        try:
            async for chunk in request.stream():
                if not chunk:
                    continue
                size += len(chunk)
                if max_size is not None and size > max_size:
                    raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "upload too large")
                hasher.update(chunk)
                await anyio.to_thread.run_sync(fh.write, chunk)
            await anyio.to_thread.run_sync(fh.flush)
        finally:
            await anyio.to_thread.run_sync(fh.close)
    except BaseException:
        await anyio.to_thread.run_sync(lambda: path.unlink(missing_ok=True))
        raise
    return token, path, hasher.hexdigest(), size
