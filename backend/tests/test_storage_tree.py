"""``GET /storage/tree`` (R13b): one level of the canonical storage layout,
derived from ``File.storage_path`` prefixes -- no filesystem walk.
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


async def test_storage_tree_root_lists_models_not_dirs(
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
    assert body["dirs"] == []
    slugs = {m["slug"] for m in body["models"]}
    assert {model_a["slug"], model_b["slug"]} <= slugs


async def test_storage_tree_nested_path_lists_revision_dirs(
    authenticated_client: httpx.AsyncClient,
) -> None:
    model = await _create_model(authenticated_client, "Tree Nested")
    upload = await _upload(
        authenticated_client,
        model_id=model["id"],
        revision_id=model["current_revision"]["id"],
        rel_path="a.stl",
        content=b"nested-content",
    )
    assert upload.status_code == 201, upload.text

    response = await authenticated_client.get(f"/api/storage/tree?path={model['slug']}")

    assert response.status_code == 200
    body = response.json()
    assert body["path"] == model["slug"]
    assert body["models"] == []
    dir_names = {d["name"] for d in body["dirs"]}
    assert model["current_revision"]["dir_name"] in dir_names
    entry = next(d for d in body["dirs"] if d["name"] == model["current_revision"]["dir_name"])
    assert entry["count"] == 1


async def test_storage_tree_unknown_path_returns_empty(
    authenticated_client: httpx.AsyncClient,
) -> None:
    response = await authenticated_client.get("/api/storage/tree?path=does-not-exist")

    assert response.status_code == 200
    body = response.json()
    assert body["dirs"] == []
    assert body["models"] == []


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
    slugs = {m["slug"] for m in response.json()["models"]}
    assert model["slug"] not in slugs
