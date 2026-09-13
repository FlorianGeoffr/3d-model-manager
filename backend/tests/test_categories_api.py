"""Categories: CRUD + gallery filter + delete SET NULL (R13b)."""

from __future__ import annotations

import httpx
import pytest

pytestmark = pytest.mark.usefixtures("library_root", "data_dir")


async def _create_model(client: httpx.AsyncClient, name: str) -> dict:
    response = await client.post("/api/models", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


async def test_create_category(authenticated_client: httpx.AsyncClient) -> None:
    response = await authenticated_client.post(
        "/api/categories", json={"name": "Vases", "color": "blue"}
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["name"] == "Vases"
    assert body["color"] == "blue"
    assert body["model_count"] == 0


async def test_create_category_duplicate_name_is_409(
    authenticated_client: httpx.AsyncClient,
) -> None:
    await authenticated_client.post("/api/categories", json={"name": "Tools"})

    response = await authenticated_client.post("/api/categories", json={"name": "Tools"})

    assert response.status_code == 409


async def test_create_category_empty_name_is_422(authenticated_client: httpx.AsyncClient) -> None:
    response = await authenticated_client.post("/api/categories", json={"name": "  "})

    assert response.status_code == 422


async def test_create_category_invalid_color_is_422(
    authenticated_client: httpx.AsyncClient,
) -> None:
    response = await authenticated_client.post(
        "/api/categories", json={"name": "Bad Color", "color": "not-a-color"}
    )

    assert response.status_code == 422


async def test_list_categories_includes_model_counts(
    authenticated_client: httpx.AsyncClient,
) -> None:
    category = (
        await authenticated_client.post("/api/categories", json={"name": "Figurines"})
    ).json()
    model_a = await _create_model(authenticated_client, "Cat Count A")
    model_b = await _create_model(authenticated_client, "Cat Count B")
    await authenticated_client.patch(
        f"/api/models/{model_a['slug']}", json={"category_id": category["id"]}
    )
    await authenticated_client.patch(
        f"/api/models/{model_b['slug']}", json={"category_id": category["id"]}
    )

    listing = await authenticated_client.get("/api/categories")

    assert listing.status_code == 200
    entry = next(c for c in listing.json() if c["id"] == category["id"])
    assert entry["model_count"] == 2


async def test_update_category_renames_and_recolors(
    authenticated_client: httpx.AsyncClient,
) -> None:
    category = (
        await authenticated_client.post("/api/categories", json={"name": "Old Name"})
    ).json()

    response = await authenticated_client.patch(
        f"/api/categories/{category['id']}", json={"name": "New Name", "color": "green"}
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == "New Name"
    assert body["color"] == "green"


async def test_update_category_only_changes_sent_fields(
    authenticated_client: httpx.AsyncClient,
) -> None:
    category = (
        await authenticated_client.post(
            "/api/categories", json={"name": "Partial Patch", "color": "red"}
        )
    ).json()

    response = await authenticated_client.patch(
        f"/api/categories/{category['id']}", json={"color": "teal"}
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == "Partial Patch"
    assert body["color"] == "teal"


async def test_update_category_duplicate_name_is_409(
    authenticated_client: httpx.AsyncClient,
) -> None:
    await authenticated_client.post("/api/categories", json={"name": "Taken"})
    other = (await authenticated_client.post("/api/categories", json={"name": "Renamable"})).json()

    response = await authenticated_client.patch(
        f"/api/categories/{other['id']}", json={"name": "Taken"}
    )

    assert response.status_code == 409


async def test_update_category_unknown_id_is_404(authenticated_client: httpx.AsyncClient) -> None:
    response = await authenticated_client.patch("/api/categories/999999", json={"name": "Nope"})

    assert response.status_code == 404


async def test_delete_category_unknown_id_is_404(authenticated_client: httpx.AsyncClient) -> None:
    response = await authenticated_client.delete("/api/categories/999999")

    assert response.status_code == 404


async def test_delete_category_sets_model_category_null(
    authenticated_client: httpx.AsyncClient,
) -> None:
    category = (
        await authenticated_client.post("/api/categories", json={"name": "Deletable"})
    ).json()
    model = await _create_model(authenticated_client, "Cat Delete SET NULL")
    await authenticated_client.patch(
        f"/api/models/{model['slug']}", json={"category_id": category["id"]}
    )

    response = await authenticated_client.delete(f"/api/categories/{category['id']}")
    assert response.status_code == 204

    detail = await authenticated_client.get(f"/api/models/{model['slug']}")
    assert detail.json()["category_id"] is None
    assert detail.json()["category"] is None

    listing = await authenticated_client.get("/api/categories")
    assert all(c["id"] != category["id"] for c in listing.json())


# ---------------------------------------------------------------------------
# assigning a category to a model
# ---------------------------------------------------------------------------


async def test_patch_model_assigns_category(authenticated_client: httpx.AsyncClient) -> None:
    category = (
        await authenticated_client.post("/api/categories", json={"name": "Assign Me"})
    ).json()
    model = await _create_model(authenticated_client, "Cat Assign")

    response = await authenticated_client.patch(
        f"/api/models/{model['slug']}", json={"category_id": category["id"]}
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["category_id"] == category["id"]
    assert body["category"] == {
        "id": category["id"],
        "name": "Assign Me",
        "color": None,
    }


async def test_patch_model_clears_category(authenticated_client: httpx.AsyncClient) -> None:
    category = (
        await authenticated_client.post("/api/categories", json={"name": "Clear Me"})
    ).json()
    model = await _create_model(authenticated_client, "Cat Clear")
    await authenticated_client.patch(
        f"/api/models/{model['slug']}", json={"category_id": category["id"]}
    )

    response = await authenticated_client.patch(
        f"/api/models/{model['slug']}", json={"category_id": None}
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["category_id"] is None
    assert body["category"] is None


async def test_patch_model_unknown_category_id_is_422(
    authenticated_client: httpx.AsyncClient,
) -> None:
    model = await _create_model(authenticated_client, "Cat Unknown")

    response = await authenticated_client.patch(
        f"/api/models/{model['slug']}", json={"category_id": 999999}
    )

    assert response.status_code == 422


# ---------------------------------------------------------------------------
# gallery filter
# ---------------------------------------------------------------------------


async def test_gallery_category_filter(authenticated_client: httpx.AsyncClient) -> None:
    category = (
        await authenticated_client.post("/api/categories", json={"name": "Gallery Filter"})
    ).json()
    in_category = await _create_model(authenticated_client, "Cat Gallery In")
    await _create_model(authenticated_client, "Cat Gallery Out")
    await authenticated_client.patch(
        f"/api/models/{in_category['slug']}", json={"category_id": category["id"]}
    )

    response = await authenticated_client.get(f"/api/models?category={category['id']}")

    assert response.status_code == 200
    items = response.json()["items"]
    assert [i["slug"] for i in items] == [in_category["slug"]]
