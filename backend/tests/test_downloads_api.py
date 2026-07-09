"""``GET /api/files/{id}/download`` (SPEC "API surface", Task 6 interface
decisions): streamed download, correct headers, and the "still processing"
409 for files not yet on backend storage.
"""

from __future__ import annotations

from datetime import UTC, datetime

import httpx
import pytest

from app.config import get_settings
from app.models import Blob, File, FileLocation, Model, Revision
from app.models.enums import BlobFormat, BlobKind
from app.services import storage_backends as sb
from app.storage.config import LocalConfig
from app.storage.local import LocalStorageBackend

pytestmark = pytest.mark.usefixtures("library_root", "data_dir")


async def _create_model(client: httpx.AsyncClient, name: str) -> dict:
    response = await client.post("/api/models", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


async def test_download_roundtrip_bytes_identical(
    authenticated_client: httpx.AsyncClient,
) -> None:
    created = await _create_model(authenticated_client, "Download Target")
    revision_id = created["current_revision"]["id"]
    content = b"downloadable-bytes" * 500

    upload = await authenticated_client.put(
        "/api/uploads",
        params={"model_id": created["id"], "revision_id": revision_id, "rel_path": "part.stl"},
        content=content,
    )
    file_id = upload.json()["file_id"]

    response = await authenticated_client.get(f"/api/files/{file_id}/download")

    assert response.status_code == 200
    assert response.content == content
    assert response.headers["content-length"] == str(len(content))
    assert 'filename="part.stl"' in response.headers["content-disposition"]


async def test_download_preserves_nested_rel_path_basename(
    authenticated_client: httpx.AsyncClient,
) -> None:
    created = await _create_model(authenticated_client, "Nested Download Target")
    revision_id = created["current_revision"]["id"]

    upload = await authenticated_client.put(
        "/api/uploads",
        params={
            "model_id": created["id"],
            "revision_id": revision_id,
            "rel_path": "sub/dir/thing.stl",
        },
        content=b"nested-bytes",
    )
    file_id = upload.json()["file_id"]

    response = await authenticated_client.get(f"/api/files/{file_id}/download")

    assert response.status_code == 200
    assert 'filename="thing.stl"' in response.headers["content-disposition"]


async def test_download_unstored_file_is_409(
    authenticated_client: httpx.AsyncClient, db_session
) -> None:
    model = Model(slug="unstored-target", name="Unstored Target")
    db_session.add(model)
    await db_session.flush()
    revision = Revision(model_id=model.id, number=1, name="initial", dir_name="rev-001_initial")
    db_session.add(revision)
    await db_session.flush()
    model.current_revision_id = revision.id

    blob = Blob(hash="a" * 64, size=10, kind=BlobKind.MESH, format=BlobFormat.STL)
    db_session.add(blob)
    await db_session.flush()

    file = File(
        revision_id=revision.id,
        blob_hash=blob.hash,
        rel_path="not-yet-there.stl",
        storage_path=f"{model.slug}/{revision.dir_name}/not-yet-there.stl",
        verified_at=None,
    )
    db_session.add(file)
    await db_session.commit()
    await db_session.refresh(file)

    response = await authenticated_client.get(f"/api/files/{file.id}/download")

    assert response.status_code == 409


async def test_download_unknown_file_is_404(authenticated_client: httpx.AsyncClient) -> None:
    response = await authenticated_client.get("/api/files/999999/download")

    assert response.status_code == 404


async def test_download_missing_backend_object_is_404(
    authenticated_client: httpx.AsyncClient,
    db_session,
    backend: LocalStorageBackend,
    seed_file,
) -> None:
    """``verified_at`` says the backend write succeeded, but if the object
    is later removed out-of-band (manual disk edit, scanner cleanup, ...),
    ``backend.read`` raises ``StorageKeyNotFound`` -- that must surface as
    404, not an unhandled 500 (Task 6 review finding).
    """
    created = await _create_model(authenticated_client, "Missing Object Target")
    revision_id = created["current_revision"]["id"]
    model = await db_session.get(Model, created["id"])
    revision = await db_session.get(Revision, revision_id)

    file = await seed_file(model, revision, "gone.stl", b"will-be-deleted")
    backend.delete(file.storage_path)

    response = await authenticated_client.get(f"/api/files/{file.id}/download")

    assert response.status_code == 404


# ---------------------------------------------------------------------------
# Workstream C task C2: per-file backend resolution (reads) + default-backend
# write bookkeeping.
# ---------------------------------------------------------------------------


async def test_download_reads_from_the_files_own_non_default_backend(
    authenticated_client: httpx.AsyncClient,
    db_session,
    tmp_path,
) -> None:
    """A ``File`` whose ``backend_id`` points at a NON-default backend is
    read from THAT backend, not the API's shared default -- put bytes on
    backend B only, set the file's ``backend_id=B``, and confirm the
    download streams B's bytes even though B is never the default.
    """
    settings = get_settings()
    default_root = tmp_path / "default-root"
    other_root = tmp_path / "other-root"
    await sb.create_backend(
        db_session, settings, "Default", LocalConfig(root=str(default_root)), is_default=True
    )
    other = await sb.create_backend(
        db_session, settings, "Other", LocalConfig(root=str(other_root))
    )

    other_backend = LocalStorageBackend(other_root)
    content = b"bytes-that-live-only-on-the-other-backend"

    model = Model(slug="cross-backend-target", name="Cross Backend Target")
    db_session.add(model)
    await db_session.flush()
    revision = Revision(model_id=model.id, number=1, name="initial", dir_name="rev-001_initial")
    db_session.add(revision)
    await db_session.flush()
    model.current_revision_id = revision.id

    blob = Blob(hash="b" * 64, size=len(content), kind=BlobKind.MESH, format=BlobFormat.STL)
    db_session.add(blob)
    await db_session.flush()

    storage_path = f"{model.slug}/{revision.dir_name}/part.stl"
    other_backend.write(storage_path, [content])
    # Deliberately nothing written to the default root -- proves the read
    # can't be accidentally satisfied by the default backend instead.
    assert not (default_root / storage_path).exists()

    file = File(
        revision_id=revision.id,
        blob_hash=blob.hash,
        rel_path="part.stl",
        storage_path=storage_path,
        verified_at=datetime.now(UTC),
        backend_id=other.id,
    )
    db_session.add(file)
    await db_session.commit()
    await db_session.refresh(file)

    response = await authenticated_client.get(f"/api/files/{file.id}/download")

    assert response.status_code == 200
    assert response.content == content


async def test_upload_write_records_default_backend_and_file_location(
    authenticated_client: httpx.AsyncClient,
    db_session,
) -> None:
    """A normal upload's ``store_to_backend`` write lands on the DEFAULT
    backend (self-healed if ``storage_backends`` was empty), stamps
    ``files.backend_id``, and records a ``file_locations`` row.
    """
    created = await _create_model(authenticated_client, "Write Location Target")
    revision_id = created["current_revision"]["id"]

    upload = await authenticated_client.put(
        "/api/uploads",
        params={"model_id": created["id"], "revision_id": revision_id, "rel_path": "part.stl"},
        content=b"tracked-bytes",
    )
    assert upload.status_code == 201, upload.text
    file_id = upload.json()["file_id"]

    default_row = await sb.get_default_backend(db_session)

    file = await db_session.get(File, file_id)
    assert file.backend_id == default_row.id
    assert file.verified_at is not None

    location = await db_session.get(FileLocation, (file_id, default_row.id))
    assert location is not None
    assert location.verified_at is not None
