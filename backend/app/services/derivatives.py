"""The derivative store: pure path/DB helpers for the processing pipeline
(SPEC "Processing pipeline"; Global Constraints "Derivative store").

Every generated per-blob artifact -- thumbnails, the converted/optimized GLB,
per-plate preview PNGs, the meshopt browser GLB -- lives under
``{settings.data_dir}/derivatives/``, sharded into two levels of
subdirectories by the blob's own hash, NEVER inside the library tree
(originals are immutable -- the pipeline only ever reads library bytes via
``StorageBackend.read``). Two of the paths here (``plate_thumb_path``,
``glb_web_path``) are deliberately rowless: derived, deterministic filenames
with no ``derivatives`` table row, needed because the browser-only
meshopt-compressed GLB is a distinct artifact from the ``glb`` derivative row
(Global Constraints "Two GLB artifacts per blob" -- the row is always the
uncompressed conversion output; gltfpack's meshopt output can't be read back
by f3d/trimesh/OCCT).

This module is pure path/DB plumbing -- no Celery, no tool invocations. The
actual conversion/render steps (Tasks 2-6) call through it from the worker's
sync world (``upsert_derivative``/``mark_derivative``/``fetch_blob_to_temp``,
all plain ``sqlalchemy.orm.Session``); the path functions have no DB
dependency at all and are usable from either world.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import Derivative, File
from app.models.enums import DerivativeKind, DerivativeStatus
from app.storage.base import StorageBackend

SUFFIXES: dict[DerivativeKind, str] = {
    DerivativeKind.THUMB_256: "thumb_256.png",
    DerivativeKind.THUMB_1024: "thumb_1024.png",
    DerivativeKind.GLB: "glb",
    DerivativeKind.GLB_PREVIEW: "glb_preview.glb",
}


def _derivative_dir(settings: Settings, blob_hash: str) -> Path:
    """The two-level hash-sharded directory a blob's derivatives live under."""
    return Path(settings.data_dir) / "derivatives" / blob_hash[:2] / blob_hash[2:4]


def derivative_path(settings: Settings, blob_hash: str, kind: DerivativeKind) -> Path:
    """Path for a DB-tracked derivative (one ``derivatives`` row per
    ``(blob_hash, kind)`` -- see ``SUFFIXES``).
    """
    return _derivative_dir(settings, blob_hash) / f"{blob_hash}.{SUFFIXES[kind]}"


def plate_thumb_path(settings: Settings, blob_hash: str, index: int) -> Path:
    """Path for a sliced-3MF embedded plate thumbnail (rowless, like
    ``glb_web_path`` -- there's no bounded set of plates to model as a
    ``DerivativeKind``).
    """
    return _derivative_dir(settings, blob_hash) / f"{blob_hash}.plate_{index}.png"


def glb_web_path(settings: Settings, blob_hash: str) -> Path:
    """Path for the meshopt-compressed, browser-only GLB (rowless: this is
    NOT the ``derivatives`` ``glb`` row, which is always the uncompressed
    conversion output -- see Global Constraints "Two GLB artifacts per
    blob"). ``GET /api/blobs/{hash}/glb`` serves this file when present, else
    falls back to the raw ``glb`` derivative.
    """
    return _derivative_dir(settings, blob_hash) / f"{blob_hash}.glb_web.glb"


def assembly_thumb_path(settings: Settings, revision_id: int) -> Path:
    """Path for a whole-revision assembly thumbnail (SPEC ``assembly_thumbs``,
    rendered per-revision rather than per-blob).
    """
    return Path(settings.data_dir) / "derivatives" / "assembly" / f"{revision_id}.png"


def publish_file(tmp: Path, dest: Path) -> None:
    """Atomically publish a worker-written temp file to its final derivative
    path: create ``dest``'s parent, then ``os.replace`` (same-filesystem
    rename, atomic) and relax the mode to a normal 0644.

    Mirrors ``LocalStorageBackend.write``'s M1 lesson: staging tools
    (``tempfile.mkstemp`` and friends) create temp files mode 0600 regardless
    of umask, which would otherwise leave derivative files readable only by
    the worker's own user.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    os.replace(tmp, dest)
    os.chmod(dest, 0o644)


def publish_bytes(data: bytes, dest: Path) -> None:
    """Stage ``data`` as a temp file in ``dest``'s own parent directory --
    guaranteeing the same filesystem as the final path, so ``publish_file``'s
    ``os.replace`` is never asked to cross a mount boundary -- then publish
    it. Shared by every step that already holds the final bytes in memory
    (embedded/rendered thumbnails, plate PNGs); a step whose own external
    tool writes its output straight to a path (``convert_to_glb``'s
    trimesh/cascadio/OCP, ``optimize_glb``'s gltfpack subprocess) stages its
    own ``tempfile.mkstemp`` directly instead, since there's no in-memory
    bytes blob to hand off here.
    """
    dest.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=dest.parent, prefix=".tdmm-pub-", suffix=dest.suffix)
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
    except BaseException:
        tmp_path.unlink(missing_ok=True)
        raise
    publish_file(tmp_path, dest)


def upsert_derivative(session: Session, blob_hash: str, kind: DerivativeKind) -> Derivative:
    """Get-or-create the ``derivatives`` row for ``(blob_hash, kind)``.

    Re-running a step (manual retry, or a later revision sharing this blob)
    resets an existing row back to ``pending``/``error=None`` before the step
    redoes the work, so a previous run's terminal state can't linger.
    """
    deriv = session.execute(
        select(Derivative).where(Derivative.blob_hash == blob_hash, Derivative.kind == kind)
    ).scalar_one_or_none()
    if deriv is None:
        deriv = Derivative(blob_hash=blob_hash, kind=kind, status=DerivativeStatus.PENDING)
        session.add(deriv)
    else:
        deriv.status = DerivativeStatus.PENDING
        deriv.error = None
    session.commit()
    session.refresh(deriv)
    return deriv


def mark_derivative(
    session: Session,
    deriv: Derivative,
    *,
    status: DerivativeStatus,
    local_path: str | None = None,
    tool: str | None = None,
    error: str | None = None,
) -> None:
    """Set a derivative's terminal fields after a step attempt and commit."""
    deriv.status = status
    deriv.local_path = local_path
    deriv.tool = tool
    deriv.error = error
    session.commit()


def fetch_blob_to_temp(
    session: Session,
    backend: StorageBackend,
    blob_hash: str,
    dest_dir: Path,
    suffix: str,
) -> Path:
    """Stream the first verified stored copy of ``blob_hash`` to
    ``dest_dir/blob{suffix}`` and return that path.

    ``suffix`` is the original file extension (e.g. ``".stl"``) -- tools like
    trimesh/lib3mf sniff format by file extension, not content, so the temp
    file must carry it even though the blob itself is addressed by hash.
    Picks the ``id``-ordered first ``File`` row for this blob with
    ``verified_at IS NOT NULL``; since a blob is content-addressed, any
    verified copy has identical bytes, so which one is picked doesn't matter
    beyond making the choice deterministic. Raises ``LookupError`` if no
    verified copy exists (e.g. every file pointing at this blob is still
    mid-upload).
    """
    file = (
        session.execute(
            select(File)
            .where(File.blob_hash == blob_hash, File.verified_at.is_not(None))
            .order_by(File.id)
        )
        .scalars()
        .first()
    )
    if file is None:
        raise LookupError("no stored copy of blob")

    dest = dest_dir / f"blob{suffix}"
    with dest.open("wb") as fh:
        for chunk in backend.read(file.storage_path):
            fh.write(chunk)
    return dest
