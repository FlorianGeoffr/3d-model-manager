"""``GET /storage/tree`` (R13b): drillable file browser over the canonical
storage layout, derived from ``File.storage_path`` prefixes -- no
filesystem walk.
"""

from __future__ import annotations

import blake3
import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.enums import BlobFormat, BlobKind
from app.models.library import Blob, File, Model, Revision

pytestmark = pytest.mark.usefixtures("library_root", "data_dir")


async def _create_model(client: httpx.AsyncClient, name: str) -> dict:
    response = await client.post("/api/models", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


async def _upload(
    client: httpx.AsyncClient, *, model_id: int, revision_id: int, rel_path: str, content: bytes
) -> httpx.Response:
    return await client.put(
        "/api/uploads",
        params={"model_id": model_id, "revision_id": revision_id, "rel_path": rel_path},
        content=content,
    )


async def _seed_file(
    db_session: AsyncSession, *, model: dict, rel_path: str, content: bytes = b"x"
) -> None:
    revision = await db_session.get(Revision, model["current_revision"]["id"])
    m = await db_session.get(Model, model["id"])
    digest = blake3.blake3(content).hexdigest()
    blob = await db_session.get(Blob, digest)
    if blob is None:
        blob = Blob(hash=digest, size=len(content), kind=BlobKind.OTHER, format=BlobFormat.OTHER)
        db_session.add(blob)
        await db_session.flush()
    db_session.add(
        File(
            revision_id=revision.id,
            blob_hash=digest,
            rel_path=rel_path,
            storage_path=f"{m.slug}/{revision.dir_name}/{rel_path}",
            verified_at=None,
        )
    )
    await db_session.commit()


async def test_storage_tree_root_lists_slug_dirs_no_files(
    authenticated_client: httpx.AsyncClient,
) -> None:
    model_a = await _create_model(authenticated_client, "Tree Root A")
    model_b = await _create_model(authenticated_client, "Tree Root B")
    for model in (model_a, model_b):
        upload = await _upload(
            authenticated_client,
            model_id=model["id"],
            revision_id=model["current_revision"]["id"],
            rel_path="part.stl",
            content=f"content-{model['id']}".encode(),
        )
        assert upload.status_code == 201, upload.text

    response = await authenticated_client.get("/api/storage/tree")

    assert response.status_code == 200
    body = response.json()
    assert body["path"] == ""
    assert body["files"] == []
    assert body["model"] is None
    dirs_by_name = {d["name"]: d for d in body["dirs"]}
    assert model_a["slug"] in dirs_by_name
    assert model_b["slug"] in dirs_by_name
    for model in (model_a, model_b):
        entry = dirs_by_name[model["slug"]]
        assert entry["path"] == model["slug"]
        assert entry["file_count"] == 1
        assert entry["model_count"] == 1


async def test_storage_tree_model_dir_lists_revision_dirs_and_summary(
    authenticated_client: httpx.AsyncClient,
) -> None:
    model = await _create_model(authenticated_client, "Tree Model Dir")
    upload = await _upload(
        authenticated_client,
        model_id=model["id"],
        revision_id=model["current_revision"]["id"],
        rel_path="a.stl",
        content=b"model-dir-content",
    )
    assert upload.status_code == 201, upload.text

    response = await authenticated_client.get(f"/api/storage/tree?path={model['slug']}")

    assert response.status_code == 200
    body = response.json()
    assert body["path"] == model["slug"]
    assert body["files"] == []
    assert body["model"] is not None
    assert body["model"]["slug"] == model["slug"]
    dir_name = model["current_revision"]["dir_name"]
    entry = next(d for d in body["dirs"] if d["name"] == dir_name)
    assert entry["path"] == f"{model['slug']}/{dir_name}"
    assert entry["file_count"] == 1
    assert entry["model_count"] == 1


async def test_storage_tree_revision_dir_lists_files_and_subdirs(
    authenticated_client: httpx.AsyncClient,
) -> None:
    model = await _create_model(authenticated_client, "Tree Revision Dir")
    revision_id = model["current_revision"]["id"]
    dir_name = model["current_revision"]["dir_name"]
    upload_top = await _upload(
        authenticated_client,
        model_id=model["id"],
        revision_id=revision_id,
        rel_path="a.stl",
        content=b"top-level-content",
    )
    assert upload_top.status_code == 201, upload_top.text
    upload_nested = await _upload(
        authenticated_client,
        model_id=model["id"],
        revision_id=revision_id,
        rel_path="images/cover.png",
        content=b"nested-content",
    )
    assert upload_nested.status_code == 201, upload_nested.text

    response = await authenticated_client.get(f"/api/storage/tree?path={model['slug']}/{dir_name}")

    assert response.status_code == 200
    body = response.json()
    assert body["path"] == f"{model['slug']}/{dir_name}"
    assert body["model"] is not None
    assert body["model"]["slug"] == model["slug"]
    file_names = {f["name"] for f in body["files"]}
    assert file_names == {"a.stl"}
    file_entry = next(f for f in body["files"] if f["name"] == "a.stl")
    assert file_entry["rel_path"] == "a.stl"
    assert file_entry["model_slug"] == model["slug"]
    assert file_entry["revision_id"] == revision_id
    dir_names = {d["name"] for d in body["dirs"]}
    assert dir_names == {"images"}
    images_entry = next(d for d in body["dirs"] if d["name"] == "images")
    assert images_entry["path"] == f"{model['slug']}/{dir_name}/images"
    assert images_entry["file_count"] == 1
    assert images_entry["model_count"] == 1


async def test_storage_tree_subdir_lists_files(
    authenticated_client: httpx.AsyncClient,
) -> None:
    model = await _create_model(authenticated_client, "Tree Subdir")
    revision_id = model["current_revision"]["id"]
    dir_name = model["current_revision"]["dir_name"]
    upload = await _upload(
        authenticated_client,
        model_id=model["id"],
        revision_id=revision_id,
        rel_path="images/cover.png",
        content=b"subdir-content",
    )
    assert upload.status_code == 201, upload.text

    response = await authenticated_client.get(
        f"/api/storage/tree?path={model['slug']}/{dir_name}/images"
    )

    assert response.status_code == 200
    body = response.json()
    assert body["path"] == f"{model['slug']}/{dir_name}/images"
    assert body["dirs"] == []
    assert body["model"] is not None
    assert body["model"]["slug"] == model["slug"]
    assert len(body["files"]) == 1
    file_entry = body["files"][0]
    assert file_entry["name"] == "cover.png"
    assert file_entry["rel_path"] == "images/cover.png"
    assert file_entry["model_slug"] == model["slug"]


async def test_storage_tree_unknown_path_returns_empty(
    authenticated_client: httpx.AsyncClient,
) -> None:
    response = await authenticated_client.get("/api/storage/tree?path=does-not-exist")

    assert response.status_code == 200
    body = response.json()
    assert body["dirs"] == []
    assert body["files"] == []
    assert body["model"] is None


async def test_storage_tree_traversal_path_returns_empty(
    authenticated_client: httpx.AsyncClient,
) -> None:
    response = await authenticated_client.get("/api/storage/tree?path=../../etc")

    assert response.status_code == 200
    body = response.json()
    assert body["dirs"] == []
    assert body["files"] == []
    assert body["model"] is None


async def test_storage_tree_excludes_snapshot_only_model(
    authenticated_client: httpx.AsyncClient, db_session: AsyncSession
) -> None:
    """A model whose only file is an internal cover snapshot
    (``_snapshots/...``) must not surface at the storage root at all --
    same exclusion rule as every other user-facing file listing
    (``app.services.layout.is_snapshot_path``)."""
    model = await _create_model(authenticated_client, "Tree Snapshot Only")
    await _seed_file(db_session, model=model, rel_path="_snapshots/cover-1.png")

    response = await authenticated_client.get("/api/storage/tree")

    assert response.status_code == 200
    dir_names = {d["name"] for d in response.json()["dirs"]}
    assert model["slug"] not in dir_names
