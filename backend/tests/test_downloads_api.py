"""``GET /api/files/{id}/download`` (SPEC "API surface", Task 6 interface
decisions): streamed download, correct headers, and the "still processing"
409 for files not yet on backend storage.
"""

from __future__ import annotations

import httpx
import pytest

from app.models import Blob, File, Model, Revision
from app.models.enums import BlobFormat, BlobKind

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
