"""Round-trip insert across the core content chain (model -> revision -> blob
-> file), plus the two uniques and enum-rejection behavior explicitly called
out by the Task 2 brief.
"""

import hashlib

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.enums import BlobFormat, BlobKind
from app.models.library import Blob, File, Model, Revision


def _hash(seed: str) -> str:
    """A deterministic 64-char stand-in for a blake3 hex digest."""
    return hashlib.sha256(seed.encode()).hexdigest()


async def test_round_trip_model_revision_blob_file(db_session: AsyncSession) -> None:
    model = Model(slug="cube-holder", name="Cube Holder")
    db_session.add(model)
    await db_session.flush()

    revision = Revision(model_id=model.id, number=1, dir_name="rev-001_initial")
    db_session.add(revision)
    await db_session.flush()

    blob = Blob(hash=_hash("cube.stl"), size=4096, kind=BlobKind.MESH, format=BlobFormat.STL)
    db_session.add(blob)
    await db_session.flush()

    file = File(
        revision_id=revision.id,
        blob_hash=blob.hash,
        rel_path="cube.stl",
        storage_path=f"{model.slug}/{revision.dir_name}/cube.stl",
    )
    db_session.add(file)
    await db_session.commit()

    fetched = await db_session.get(File, file.id)
    assert fetched is not None
    assert fetched.revision_id == revision.id
    assert fetched.blob_hash == blob.hash
    assert fetched.rel_path == "cube.stl"

    await db_session.refresh(fetched, attribute_names=["blob"])
    assert fetched.blob.size == 4096
    assert fetched.blob.kind == BlobKind.MESH


async def test_unique_model_id_number_enforced(db_session: AsyncSession) -> None:
    model = Model(slug="dup-revision-numbers", name="Dup Revision Numbers")
    db_session.add(model)
    await db_session.flush()

    db_session.add(Revision(model_id=model.id, number=1, dir_name="rev-001_a"))
    await db_session.commit()

    db_session.add(Revision(model_id=model.id, number=1, dir_name="rev-001_b"))
    with pytest.raises(IntegrityError):
        await db_session.commit()


async def test_unique_revision_id_rel_path_enforced(db_session: AsyncSession) -> None:
    model = Model(slug="dup-file-paths", name="Dup File Paths")
    db_session.add(model)
    await db_session.flush()

    revision = Revision(model_id=model.id, number=1, dir_name="rev-001_initial")
    db_session.add(revision)
    await db_session.flush()

    blob_a = Blob(hash=_hash("a"), size=1, kind=BlobKind.MESH, format=BlobFormat.STL)
    blob_b = Blob(hash=_hash("b"), size=2, kind=BlobKind.MESH, format=BlobFormat.STL)
    db_session.add_all([blob_a, blob_b])
    await db_session.flush()

    db_session.add(
        File(
            revision_id=revision.id,
            blob_hash=blob_a.hash,
            rel_path="part.stl",
            storage_path="x/part.stl",
        )
    )
    await db_session.commit()

    db_session.add(
        File(
            revision_id=revision.id,
            blob_hash=blob_b.hash,
            rel_path="part.stl",
            storage_path="x/part-2.stl",
        )
    )
    with pytest.raises(IntegrityError):
        await db_session.commit()


async def test_blob_kind_enum_rejects_bad_value_via_orm(db_session: AsyncSession) -> None:
    """``values_callable`` makes ``sa.Enum`` pass plain strings straight
    through to the DB rather than validating client-side, so an invalid
    value assigned through the ORM is only caught once it hits the
    migration-created CHECK constraint on flush. "bogus" is chosen to be
    the same length as a real value (e.g. "image"/"other") so this isn't
    accidentally just a VARCHAR(n) length truncation error -- it proves the
    CHECK constraint itself is doing the enforcement.
    """
    bad_blob = Blob(hash=_hash("bad-kind"), size=1, kind="bogus", format=BlobFormat.STL)
    db_session.add(bad_blob)

    with pytest.raises(IntegrityError):
        await db_session.flush()


async def test_blob_format_enum_rejects_bad_value_at_db_level(db_session: AsyncSession) -> None:
    """Bypass the ORM/Python enum entirely with a raw SQL insert, to prove
    the migration actually created a DB-level CHECK constraint (SPEC:
    enums are ``sa.Enum(..., native_enum=False)``, i.e. VARCHAR + CHECK) --
    not just app-level validation. "bogus" again matches a real value's
    length ("other") to isolate the CHECK constraint from column sizing.
    """
    with pytest.raises(DBAPIError):
        await db_session.execute(
            text("INSERT INTO blobs (hash, size, kind, format) VALUES (:hash, 1, 'mesh', 'bogus')"),
            {"hash": _hash("bad-format")},
        )
