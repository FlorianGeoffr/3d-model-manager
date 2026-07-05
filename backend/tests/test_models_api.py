"""Model CRUD + gallery listing (Task 5 brief): slug generation/collision,
sidecar content, PATCH/DELETE(archive) semantics, and the gallery's
search/filter/sort/cursor-pagination behavior.
"""

import json
from collections.abc import Awaitable, Callable

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import File, Model, Revision
from app.models.enums import BlobFormat
from app.storage.local import LocalStorageBackend

pytestmark = pytest.mark.usefixtures("library_root")


async def _create_model(
    client: httpx.AsyncClient, name: str, description: str | None = None
) -> dict:
    payload = {"name": name}
    if description is not None:
        payload["description"] = description
    response = await client.post("/api/models", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


# ---------------------------------------------------------------------------
# creation: slug, revision 1, storage side effects
# ---------------------------------------------------------------------------


async def test_create_model_sets_up_slug_revision_and_storage(
    authenticated_client: httpx.AsyncClient, backend: LocalStorageBackend
) -> None:
    body = await _create_model(authenticated_client, "Cube Holder", "Holds cubes")

    assert body["slug"] == "cube-holder"
    assert body["name"] == "Cube Holder"
    assert body["description"] == "Holds cubes"
    assert body["is_archived"] is False
    assert body["tags"] == []
    assert body["notes"] == []

    revision = body["current_revision"]
    assert revision["number"] == 1
    assert revision["name"] == "initial"
    assert revision["dir_name"] == "rev-001_initial"
    assert revision["files"] == []

    assert backend.exists("cube-holder/.3dmm.json")
    # mkdirs actually created the revision directory on disk.
    assert (backend.root / "cube-holder" / "rev-001_initial").is_dir()


async def test_create_model_writes_sidecar_with_expected_content(
    authenticated_client: httpx.AsyncClient, backend: LocalStorageBackend
) -> None:
    body = await _create_model(authenticated_client, "Sidecar Test")

    sidecar = json.loads(b"".join(backend.read("sidecar-test/.3dmm.json")))

    assert sidecar == {"model_id": body["id"], "slug": "sidecar-test", "name": "Sidecar Test"}


async def test_create_model_slug_collision_gets_numeric_suffix(
    authenticated_client: httpx.AsyncClient,
) -> None:
    first = await _create_model(authenticated_client, "Cube Holder")
    second = await _create_model(authenticated_client, "Cube Holder")
    third = await _create_model(authenticated_client, "Cube Holder")

    assert first["slug"] == "cube-holder"
    assert second["slug"] == "cube-holder-2"
    assert third["slug"] == "cube-holder-3"


@pytest.mark.parametrize("bad_name", ["", "   "])
async def test_create_model_empty_name_is_422(
    authenticated_client: httpx.AsyncClient, bad_name: str
) -> None:
    response = await authenticated_client.post("/api/models", json={"name": bad_name})

    assert response.status_code == 422


async def test_models_require_authentication(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/models")

    assert response.status_code == 401


# ---------------------------------------------------------------------------
# get / patch / archive
# ---------------------------------------------------------------------------


async def test_get_model_by_slug_returns_404_for_unknown_slug(
    authenticated_client: httpx.AsyncClient,
) -> None:
    response = await authenticated_client.get("/api/models/does-not-exist")

    assert response.status_code == 404


async def test_patch_model_updates_description_without_touching_slug(
    authenticated_client: httpx.AsyncClient,
) -> None:
    created = await _create_model(authenticated_client, "Patchable Thing", "before")

    response = await authenticated_client.patch(
        f"/api/models/{created['slug']}", json={"description": "after"}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["description"] == "after"
    assert body["slug"] == created["slug"]
    assert body["name"] == "Patchable Thing"


async def test_patch_model_name_does_not_change_slug_or_dirs(
    authenticated_client: httpx.AsyncClient, backend: LocalStorageBackend
) -> None:
    created = await _create_model(authenticated_client, "Original Name")

    response = await authenticated_client.patch(
        f"/api/models/{created['slug']}", json={"name": "Renamed Thing"}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "Renamed Thing"
    assert body["slug"] == "original-name"
    assert backend.exists("original-name/.3dmm.json")


async def test_delete_model_archives_and_excludes_from_default_gallery(
    authenticated_client: httpx.AsyncClient,
) -> None:
    created = await _create_model(authenticated_client, "Archive Me")

    response = await authenticated_client.delete(f"/api/models/{created['slug']}")
    assert response.status_code == 204

    detail = await authenticated_client.get(f"/api/models/{created['slug']}")
    assert detail.json()["is_archived"] is True

    default_gallery = await authenticated_client.get("/api/models")
    slugs = [item["slug"] for item in default_gallery.json()["items"]]
    assert created["slug"] not in slugs

    with_archived = await authenticated_client.get("/api/models?archived=true")
    slugs_with_archived = [item["slug"] for item in with_archived.json()["items"]]
    assert created["slug"] in slugs_with_archived


# ---------------------------------------------------------------------------
# gallery: search / tag / format filters
# ---------------------------------------------------------------------------


async def test_gallery_q_filters_by_name_or_description(
    authenticated_client: httpx.AsyncClient,
) -> None:
    await _create_model(authenticated_client, "Widget", "a small gadget")
    await _create_model(authenticated_client, "Gadget", "a small widget")
    await _create_model(authenticated_client, "Unrelated Thing", "nothing to see here")

    response = await authenticated_client.get("/api/models?q=widget")

    names = {item["name"] for item in response.json()["items"]}
    assert names == {"Widget", "Gadget"}


async def test_gallery_tag_filter_matches_exact_tag_name(
    authenticated_client: httpx.AsyncClient,
) -> None:
    tagged = await _create_model(authenticated_client, "Tagged Model")
    await _create_model(authenticated_client, "Untagged Model")

    tag_response = await authenticated_client.post(
        f"/api/models/{tagged['id']}/tags", json={"name": "keychain"}
    )
    assert tag_response.status_code == 201

    response = await authenticated_client.get("/api/models?tag=keychain")

    slugs = [item["slug"] for item in response.json()["items"]]
    assert slugs == [tagged["slug"]]


async def test_gallery_format_filter_matches_current_revision_files(
    authenticated_client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_file: Callable[..., Awaitable[File]],
) -> None:
    with_stl = await _create_model(authenticated_client, "Has STL")
    await _create_model(authenticated_client, "Has Nothing")

    model = await db_session.get(Model, with_stl["id"])
    revision = await db_session.get(Revision, model.current_revision_id)
    await seed_file(model, revision, "part.stl", b"solid stl-data", blob_format=BlobFormat.STL)

    stl_response = await authenticated_client.get("/api/models?format=stl")
    obj_response = await authenticated_client.get("/api/models?format=obj")

    assert [item["slug"] for item in stl_response.json()["items"]] == [with_stl["slug"]]
    assert obj_response.json()["items"] == []

    detail = stl_response.json()["items"][0]
    assert detail["file_count"] == 1
    assert detail["formats"] == ["stl"]


# ---------------------------------------------------------------------------
# gallery: sort + cursor pagination
# ---------------------------------------------------------------------------


async def test_gallery_sort_by_name_ascending(authenticated_client: httpx.AsyncClient) -> None:
    for name in ["Charlie", "Alpha", "Bravo"]:
        await _create_model(authenticated_client, name)

    response = await authenticated_client.get("/api/models?sort=name&limit=10")

    names = [item["name"] for item in response.json()["items"]]
    assert names == ["Alpha", "Bravo", "Charlie"]


async def test_gallery_default_sort_is_updated_at_descending(
    authenticated_client: httpx.AsyncClient,
) -> None:
    first = await _create_model(authenticated_client, "First Created")
    await _create_model(authenticated_client, "Second Created")

    # Bump `first`'s updated_at so it should now sort ahead under the
    # default `-updated_at` sort despite being created earlier.
    patch_response = await authenticated_client.patch(
        f"/api/models/{first['slug']}", json={"description": "bumped"}
    )
    assert patch_response.status_code == 200

    response = await authenticated_client.get("/api/models")

    names = [item["name"] for item in response.json()["items"]]
    assert names[0] == "First Created"


async def test_gallery_cursor_pagination_round_trip_covers_all_items_without_overlap(
    authenticated_client: httpx.AsyncClient,
) -> None:
    expected_names = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]
    for name in expected_names:
        await _create_model(authenticated_client, name)

    seen: list[str] = []
    cursor = None
    for _ in range(len(expected_names) + 1):  # +1 safety margin against infinite loop
        url = "/api/models?sort=name&limit=2"
        if cursor:
            url += f"&cursor={cursor}"
        response = await authenticated_client.get(url)
        assert response.status_code == 200
        page = response.json()
        seen.extend(item["name"] for item in page["items"])
        cursor = page["next_cursor"]
        if cursor is None:
            break

    assert seen == expected_names
    assert len(seen) == len(set(seen))


async def test_gallery_invalid_cursor_is_400(authenticated_client: httpx.AsyncClient) -> None:
    response = await authenticated_client.get("/api/models?cursor=not-valid-base64!!!")

    assert response.status_code == 400


# ---------------------------------------------------------------------------
# patch: cover_blob_hash validation
# ---------------------------------------------------------------------------


async def test_patch_model_with_unknown_cover_blob_hash_is_422(
    authenticated_client: httpx.AsyncClient,
) -> None:
    created = await _create_model(authenticated_client, "Test Model")

    # 64-character hex string (valid blake3 hash length) but non-existent blob
    bogus_hash = "a" * 64

    response = await authenticated_client.patch(
        f"/api/models/{created['slug']}", json={"cover_blob_hash": bogus_hash}
    )

    assert response.status_code == 422
    detail = response.json()
    assert detail["detail"] == "unknown cover_blob_hash"


async def test_patch_model_with_valid_cover_blob_hash_persists(
    authenticated_client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_file: Callable[..., Awaitable[File]],
) -> None:
    created = await _create_model(authenticated_client, "Coverable Model")

    # Get model and revision from DB
    model = await db_session.get(Model, created["id"])
    revision = await db_session.get(Revision, model.current_revision_id)

    # Seed a file (creates blob + file)
    file = await seed_file(model, revision, "cover.stl", b"solid cover-data")

    # Now patch with this blob hash as cover
    response = await authenticated_client.patch(
        f"/api/models/{created['slug']}", json={"cover_blob_hash": file.blob_hash}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["cover_blob_hash"] == file.blob_hash

    # Verify it persisted in DB
    await db_session.refresh(model)
    assert model.cover_blob_hash == file.blob_hash


async def test_patch_model_clearing_cover_blob_hash_with_null(
    authenticated_client: httpx.AsyncClient,
    db_session: AsyncSession,
    seed_file: Callable[..., Awaitable[File]],
) -> None:
    created = await _create_model(authenticated_client, "Cover Clearable Model")

    # Get model and revision from DB
    model = await db_session.get(Model, created["id"])
    revision = await db_session.get(Revision, model.current_revision_id)

    # Seed a file and set it as cover
    file = await seed_file(model, revision, "cover.stl", b"solid cover-data")
    model.cover_blob_hash = file.blob_hash
    await db_session.commit()

    # Clear the cover by setting to null
    response = await authenticated_client.patch(
        f"/api/models/{created['slug']}", json={"cover_blob_hash": None}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["cover_blob_hash"] is None

    # Verify it persisted in DB
    await db_session.refresh(model)
    assert model.cover_blob_hash is None
