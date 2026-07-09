"""Multi-backend storage CRUD + resolution (Workstream C task C1 design
spec). Every test starts with an EMPTY ``storage_backends`` table (the
autouse ``_truncate_all_tables`` fixture wipes the migration's data-seed
between tests, same as it does the legacy ``settings`` row) -- each test
builds whatever backend rows it needs from scratch.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import HTTPException

from app.config import get_settings
from app.models import Blob, File, FileLocation, Model, Revision
from app.models.enums import BlobFormat, BlobKind
from app.services import storage_backends as sb
from app.storage.config import LocalConfig, S3Config
from app.storage.local import LocalStorageBackend

pytestmark = pytest.mark.usefixtures("library_root", "data_dir")


async def _create_file(db_session, *, backend_id: int | None, suffix: str = "a") -> File:
    """Insert a minimal Model/Revision/Blob/File chain, mirroring the
    pattern in ``tests/test_downloads_api.py``.
    """
    model = Model(slug=f"storage-backend-target-{suffix}", name=f"Target {suffix}")
    db_session.add(model)
    await db_session.flush()
    revision = Revision(model_id=model.id, number=1, name="initial", dir_name="rev-001_initial")
    db_session.add(revision)
    await db_session.flush()

    blob = Blob(hash=suffix * 64, size=10, kind=BlobKind.MESH, format=BlobFormat.STL)
    db_session.add(blob)
    await db_session.flush()

    file = File(
        revision_id=revision.id,
        blob_hash=blob.hash,
        rel_path="part.stl",
        storage_path=f"{model.slug}/{revision.dir_name}/part.stl",
        backend_id=backend_id,
    )
    db_session.add(file)
    await db_session.commit()
    await db_session.refresh(file)
    return file


# -- CRUD -------------------------------------------------------------


async def test_create_get_list_roundtrip(db_session) -> None:
    settings = get_settings()

    created = await sb.create_backend(db_session, settings, "Local disk", LocalConfig())

    assert created.id is not None
    assert created.scheme == "local"
    assert created.is_default is False

    fetched = await sb.get_backend_row(db_session, created.id)
    assert fetched.name == "Local disk"

    listed = await sb.list_backends(db_session)
    assert [row.id for row in listed] == [created.id]


async def test_get_backend_row_404_for_unknown_id(db_session) -> None:
    with pytest.raises(HTTPException) as exc_info:
        await sb.get_backend_row(db_session, 999_999)
    assert exc_info.value.status_code == 404


async def test_update_backend_name_and_config(db_session, tmp_path: Path) -> None:
    settings = get_settings()
    row = await sb.create_backend(db_session, settings, "Original", LocalConfig())

    updated = await sb.update_backend(db_session, settings, row.id, name="Renamed")
    assert updated.name == "Renamed"
    assert updated.scheme == "local"

    new_root = str(tmp_path / "moved")
    updated = await sb.update_backend(
        db_session, settings, row.id, config=LocalConfig(root=new_root)
    )
    assert updated.config["root"] == new_root


async def test_create_with_is_default_true_becomes_the_default(db_session) -> None:
    settings = get_settings()

    row = await sb.create_backend(
        db_session, settings, "Default one", LocalConfig(), is_default=True
    )

    assert row.is_default is True
    default_row = await sb.get_default_backend(db_session)
    assert default_row.id == row.id


async def test_get_default_backend_404_when_none_configured(db_session) -> None:
    with pytest.raises(HTTPException) as exc_info:
        await sb.get_default_backend(db_session)
    assert exc_info.value.status_code == 404


# -- single-default invariant ------------------------------------------


async def test_set_default_backend_flips_the_single_default_invariant(db_session) -> None:
    settings = get_settings()
    a = await sb.create_backend(db_session, settings, "A", LocalConfig(), is_default=True)
    b = await sb.create_backend(db_session, settings, "B", LocalConfig())

    result = await sb.set_default_backend(db_session, b.id)

    assert result.is_default is True
    await db_session.refresh(a)
    assert a.is_default is False
    default_row = await sb.get_default_backend(db_session)
    assert default_row.id == b.id


async def test_set_default_backend_idempotent_on_already_default(db_session) -> None:
    settings = get_settings()
    a = await sb.create_backend(db_session, settings, "A", LocalConfig(), is_default=True)

    result = await sb.set_default_backend(db_session, a.id)

    assert result.is_default is True


# -- delete guardrails ---------------------------------------------------


async def test_delete_refuses_the_last_backend(db_session) -> None:
    settings = get_settings()
    row = await sb.create_backend(db_session, settings, "Only one", LocalConfig())

    with pytest.raises(HTTPException) as exc_info:
        await sb.delete_backend(db_session, row.id)
    assert exc_info.value.status_code == 409


async def test_delete_refuses_the_default_backend(db_session) -> None:
    settings = get_settings()
    default_row = await sb.create_backend(
        db_session, settings, "Default", LocalConfig(), is_default=True
    )
    await sb.create_backend(db_session, settings, "Spare", LocalConfig())

    with pytest.raises(HTTPException) as exc_info:
        await sb.delete_backend(db_session, default_row.id)
    assert exc_info.value.status_code == 409


async def test_delete_refuses_a_backend_with_file_locations(db_session) -> None:
    settings = get_settings()
    default_row = await sb.create_backend(
        db_session, settings, "Default", LocalConfig(), is_default=True
    )
    spare = await sb.create_backend(db_session, settings, "Spare", LocalConfig())
    file = await _create_file(db_session, backend_id=spare.id)
    db_session.add(FileLocation(file_id=file.id, backend_id=spare.id))
    await db_session.commit()

    with pytest.raises(HTTPException) as exc_info:
        await sb.delete_backend(db_session, spare.id)
    assert exc_info.value.status_code == 409
    assert default_row.id  # sanity: default untouched, still resolvable
    assert await sb.get_default_backend(db_session)


async def test_delete_succeeds_for_a_non_default_unreferenced_backend(db_session) -> None:
    settings = get_settings()
    await sb.create_backend(db_session, settings, "Default", LocalConfig(), is_default=True)
    spare = await sb.create_backend(db_session, settings, "Spare", LocalConfig())

    await sb.delete_backend(db_session, spare.id)

    with pytest.raises(HTTPException):
        await sb.get_backend_row(db_session, spare.id)


# -- secrets --------------------------------------------------------------


async def test_secret_is_encrypted_at_rest_and_decrypts_back(db_session) -> None:
    settings = get_settings()
    cfg = S3Config(bucket="b", access_key="AK", secret_key="hunter2")

    row = await sb.create_backend(db_session, settings, "S3", cfg)

    # Encrypted at rest: never the plaintext secret in the stored JSONB.
    assert row.config["secret_key"] != "hunter2"
    assert row.config["access_key"] == "AK"

    backend = await sb.backend_for_id(db_session, settings, row.id)
    from app.storage.s3 import S3StorageBackend

    assert isinstance(backend, S3StorageBackend)


async def test_redacted_masks_the_decrypted_secret(db_session) -> None:
    from app.services.storage_config import decrypt_config_row
    from app.storage.config import parse_storage_config, redacted

    settings = get_settings()
    cfg = S3Config(bucket="b", access_key="AK", secret_key="hunter2")
    row = await sb.create_backend(db_session, settings, "S3", cfg)

    data, _ = decrypt_config_row(settings, dict(row.config))
    decrypted_cfg = parse_storage_config(data)
    assert decrypted_cfg.secret_key.get_secret_value() == "hunter2"
    assert redacted(decrypted_cfg)["secret_key"] == "***"


# -- resolution -----------------------------------------------------------


async def test_resolve_default_backend_returns_the_default(db_session, tmp_path: Path) -> None:
    settings = get_settings()
    root = tmp_path / "default-root"
    row = await sb.create_backend(
        db_session, settings, "Default", LocalConfig(root=str(root)), is_default=True
    )

    backend, backend_id = await sb.resolve_default_backend(db_session, settings)

    assert backend_id == row.id
    assert isinstance(backend, LocalStorageBackend)
    assert backend.root == root.resolve()


async def test_resolve_backend_for_file_uses_the_files_own_backend(
    db_session, tmp_path: Path
) -> None:
    settings = get_settings()
    default_root = tmp_path / "default-root"
    other_root = tmp_path / "other-root"
    await sb.create_backend(
        db_session, settings, "Default", LocalConfig(root=str(default_root)), is_default=True
    )
    other = await sb.create_backend(
        db_session, settings, "Other", LocalConfig(root=str(other_root))
    )
    file = await _create_file(db_session, backend_id=other.id, suffix="b")

    backend = await sb.resolve_backend_for_file(db_session, settings, file)

    assert isinstance(backend, LocalStorageBackend)
    assert backend.root == other_root.resolve()


async def test_resolve_backend_for_file_falls_back_to_default_on_null(
    db_session, tmp_path: Path
) -> None:
    settings = get_settings()
    default_root = tmp_path / "default-root"
    await sb.create_backend(
        db_session, settings, "Default", LocalConfig(root=str(default_root)), is_default=True
    )
    file = await _create_file(db_session, backend_id=None, suffix="c")

    backend = await sb.resolve_backend_for_file(db_session, settings, file)

    assert isinstance(backend, LocalStorageBackend)
    assert backend.root == default_root.resolve()


# -- sync twins (worker-side) ---------------------------------------------


def test_sync_twins_mirror_the_async_crud_and_resolution(tmp_path: Path) -> None:
    from app.tasks import base

    settings = get_settings()
    with base.sync_session() as session:
        a = sb.create_backend_sync(
            session, settings, "A", LocalConfig(root=str(tmp_path / "a")), is_default=True
        )
        b = sb.create_backend_sync(session, settings, "B", LocalConfig(root=str(tmp_path / "b")))

        assert sb.get_default_backend_sync(session).id == a.id

        flipped = sb.set_default_backend_sync(session, b.id)
        assert flipped.is_default is True
        session.refresh(a)
        assert a.is_default is False

        backend, backend_id = sb.resolve_default_backend_sync(session, settings)
        assert backend_id == b.id
        assert isinstance(backend, LocalStorageBackend)
        assert backend.root == (tmp_path / "b").resolve()

        with pytest.raises(HTTPException):
            sb.delete_backend_sync(session, b.id)  # b is the default now

        sb.delete_backend_sync(session, a.id)
        with pytest.raises(HTTPException):
            sb.get_backend_row_sync(session, a.id)
