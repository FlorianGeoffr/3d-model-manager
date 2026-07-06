"""The derivative store (``app.services.derivatives``): exact path scheme,
atomic 0644 publish, ``derivatives``-row upsert/mark round-trips, and
verified-copy blob fetching -- the seams every pipeline step (Tasks 2+)
builds on.

DB helpers run through the worker's REAL sync engine (``app.tasks.base``)
against the migrated testcontainer Postgres, exactly as the Celery steps
will call them; rows are seeded through the API-side async session, which
mirrors production (API writes, worker reads).
"""

import os
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings
from app.models import Blob, Derivative, File, Model, Revision
from app.models.enums import BlobFormat, BlobKind, DerivativeKind, DerivativeStatus
from app.services import derivatives
from app.storage.local import LocalStorageBackend
from app.tasks.base import sync_session

BLOB_HASH = "0123abcd" * 8  # 64 hex chars; shard dirs are "01"/"23"


def _settings() -> Settings:
    return Settings(data_dir=Path("/data"))


# -- path scheme --------------------------------------------------------


def test_derivative_path_scheme_exact() -> None:
    settings = _settings()
    shard = Path("/data/derivatives/01/23")

    assert derivatives.derivative_path(settings, BLOB_HASH, DerivativeKind.THUMB_256) == (
        shard / f"{BLOB_HASH}.thumb_256.png"
    )
    assert derivatives.derivative_path(settings, BLOB_HASH, DerivativeKind.THUMB_1024) == (
        shard / f"{BLOB_HASH}.thumb_1024.png"
    )
    assert derivatives.derivative_path(settings, BLOB_HASH, DerivativeKind.GLB) == (
        shard / f"{BLOB_HASH}.glb"
    )
    assert derivatives.derivative_path(settings, BLOB_HASH, DerivativeKind.GLB_PREVIEW) == (
        shard / f"{BLOB_HASH}.glb_preview.glb"
    )


def test_rowless_artifact_paths_share_the_derivative_shard_dir() -> None:
    settings = _settings()
    shard = Path("/data/derivatives/01/23")

    assert derivatives.plate_thumb_path(settings, BLOB_HASH, 1) == (
        shard / f"{BLOB_HASH}.plate_1.png"
    )
    assert derivatives.plate_thumb_path(settings, BLOB_HASH, 2) == (
        shard / f"{BLOB_HASH}.plate_2.png"
    )
    assert derivatives.glb_web_path(settings, BLOB_HASH) == shard / f"{BLOB_HASH}.glb_web.glb"


def test_assembly_thumb_path_is_keyed_by_revision_id() -> None:
    settings = _settings()

    assert derivatives.assembly_thumb_path(settings, 42) == Path(
        "/data/derivatives/assembly/42.png"
    )


# -- publish_file --------------------------------------------------------


def test_publish_file_creates_parents_and_relaxes_mode_to_0644(tmp_path: Path) -> None:
    tmp = tmp_path / "staging.png"
    tmp.write_bytes(b"png bytes")
    # What mkstemp-style staging really produces (M1's 0600-spool lesson).
    os.chmod(tmp, 0o600)
    dest = tmp_path / "derivatives" / "01" / "23" / "x.png"

    derivatives.publish_file(tmp, dest)

    assert dest.read_bytes() == b"png bytes"
    assert not tmp.exists()
    assert dest.stat().st_mode & 0o777 == 0o644


def test_publish_file_atomically_replaces_existing_dest(tmp_path: Path) -> None:
    dest = tmp_path / "x.png"
    dest.write_bytes(b"stale")
    tmp = tmp_path / "staging.png"
    tmp.write_bytes(b"fresh")

    derivatives.publish_file(tmp, dest)

    assert dest.read_bytes() == b"fresh"
    assert not tmp.exists()


# -- upsert / mark round trip ---------------------------------------------


async def test_upsert_creates_then_resets_and_mark_persists(db_session: AsyncSession) -> None:
    db_session.add(Blob(hash=BLOB_HASH, size=1, kind=BlobKind.MESH, format=BlobFormat.STL))
    await db_session.commit()

    with sync_session() as session:
        deriv = derivatives.upsert_derivative(session, BLOB_HASH, DerivativeKind.GLB)
        first_id = deriv.id
        assert deriv.status == DerivativeStatus.PENDING
        assert deriv.error is None

        derivatives.mark_derivative(
            session, deriv, status=DerivativeStatus.FAILED, tool="cascadio", error="boom"
        )

    # Re-run (retry semantics): same row, reset back to pending/error=None.
    with sync_session() as session:
        again = derivatives.upsert_derivative(session, BLOB_HASH, DerivativeKind.GLB)
        assert again.id == first_id
        assert again.status == DerivativeStatus.PENDING
        assert again.error is None

        derivatives.mark_derivative(
            session,
            again,
            status=DerivativeStatus.OK,
            local_path="/data/derivatives/01/23/x.glb",
            tool="cascadio",
        )

    row = (
        await db_session.execute(select(Derivative).where(Derivative.blob_hash == BLOB_HASH))
    ).scalar_one()
    assert row.id == first_id
    assert row.status == DerivativeStatus.OK
    assert row.local_path == "/data/derivatives/01/23/x.glb"
    assert row.tool == "cascadio"
    assert row.error is None


# -- fetch_blob_to_temp ----------------------------------------------------


async def _seed_model_and_revision(db_session: AsyncSession) -> tuple[Model, Revision]:
    model = Model(slug="widget", name="Widget")
    db_session.add(model)
    await db_session.flush()
    revision = Revision(model_id=model.id, number=1, dir_name="rev-001")
    db_session.add(revision)
    await db_session.flush()
    return model, revision


async def test_fetch_blob_to_temp_streams_verified_copy(
    db_session: AsyncSession,
    backend: LocalStorageBackend,
    seed_file,
    tmp_path: Path,
) -> None:
    model, revision = await _seed_model_and_revision(db_session)
    content = b"solid box bytes"
    file = await seed_file(model, revision, "box.stl", content)

    with sync_session() as session:
        fetched = derivatives.fetch_blob_to_temp(session, backend, file.blob_hash, tmp_path, ".stl")

    assert fetched == tmp_path / "blob.stl"
    assert fetched.read_bytes() == content


async def test_fetch_blob_to_temp_raises_when_only_unverified_copies_exist(
    db_session: AsyncSession,
    backend: LocalStorageBackend,
    tmp_path: Path,
) -> None:
    _, revision = await _seed_model_and_revision(db_session)
    db_session.add(Blob(hash=BLOB_HASH, size=1, kind=BlobKind.MESH, format=BlobFormat.STL))
    db_session.add(
        File(
            revision_id=revision.id,
            blob_hash=BLOB_HASH,
            rel_path="box.stl",
            storage_path="widget/rev-001/box.stl",
            verified_at=None,  # still mid-ingest: never a safe read source
        )
    )
    await db_session.commit()

    with sync_session() as session, pytest.raises(LookupError, match="no stored copy of blob"):
        derivatives.fetch_blob_to_temp(session, backend, BLOB_HASH, tmp_path, ".stl")
