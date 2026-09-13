"""Materials: CRUD + delete SET NULL + print create with material_id (R13c)."""

from __future__ import annotations

import httpx
import pytest

pytestmark = pytest.mark.usefixtures("library_root", "data_dir")


async def _create_model(client: httpx.AsyncClient, name: str) -> dict:
    response = await client.post("/api/models", json={"name": name})
    assert response.status_code == 201, response.text
    return response.json()


async def test_create_material(authenticated_client: httpx.AsyncClient) -> None:
    response = await authenticated_client.post(
        "/api/materials",
        json={"name": "PLA Black", "kind": "PLA", "color": "#111111", "vendor": "Bambu"},
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["name"] == "PLA Black"
    assert body["kind"] == "PLA"
    assert body["color"] == "#111111"
    assert body["vendor"] == "Bambu"
    assert body["print_count"] == 0


async def test_create_material_duplicate_name_is_409(
    authenticated_client: httpx.AsyncClient,
) -> None:
    await authenticated_client.post("/api/materials", json={"name": "PETG Clear"})

    response = await authenticated_client.post("/api/materials", json={"name": "PETG Clear"})

    assert response.status_code == 409


async def test_create_material_empty_name_is_422(authenticated_client: httpx.AsyncClient) -> None:
    response = await authenticated_client.post("/api/materials", json={"name": "  "})

    assert response.status_code == 422


async def test_create_material_invalid_color_is_422(
    authenticated_client: httpx.AsyncClient,
) -> None:
    response = await authenticated_client.post(
        "/api/materials", json={"name": "Bad Color", "color": "not-a-hex"}
    )

    assert response.status_code == 422


async def test_create_material_no_color_is_ok(authenticated_client: httpx.AsyncClient) -> None:
    response = await authenticated_client.post("/api/materials", json={"name": "No Color ABS"})

    assert response.status_code == 201, response.text
    assert response.json()["color"] is None


async def test_list_materials_includes_print_counts(
    authenticated_client: httpx.AsyncClient,
) -> None:
    material = (
        await authenticated_client.post("/api/materials", json={"name": "Count Me PLA"})
    ).json()
    model = await _create_model(authenticated_client, "Material Count Model")
    await authenticated_client.post(
        f"/api/models/{model['id']}/prints", json={"material_id": material["id"]}
    )
    await authenticated_client.post(
        f"/api/models/{model['id']}/prints", json={"material_id": material["id"]}
    )

    listing = await authenticated_client.get("/api/materials")

    assert listing.status_code == 200
    entry = next(m for m in listing.json() if m["id"] == material["id"])
    assert entry["print_count"] == 2


async def test_update_material_renames_and_recolors(
    authenticated_client: httpx.AsyncClient,
) -> None:
    material = (await authenticated_client.post("/api/materials", json={"name": "Old"})).json()

    response = await authenticated_client.patch(
        f"/api/materials/{material['id']}", json={"name": "New", "color": "#00ff00"}
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == "New"
    assert body["color"] == "#00ff00"


async def test_update_material_only_changes_sent_fields(
    authenticated_client: httpx.AsyncClient,
) -> None:
    material = (
        await authenticated_client.post(
            "/api/materials", json={"name": "Partial", "kind": "PLA", "vendor": "Vendor A"}
        )
    ).json()

    response = await authenticated_client.patch(
        f"/api/materials/{material['id']}", json={"vendor": "Vendor B"}
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["name"] == "Partial"
    assert body["kind"] == "PLA"
    assert body["vendor"] == "Vendor B"


async def test_update_material_duplicate_name_is_409(
    authenticated_client: httpx.AsyncClient,
) -> None:
    await authenticated_client.post("/api/materials", json={"name": "Taken"})
    other = (await authenticated_client.post("/api/materials", json={"name": "Renamable"})).json()

    response = await authenticated_client.patch(
        f"/api/materials/{other['id']}", json={"name": "Taken"}
    )

    assert response.status_code == 409


async def test_update_material_unknown_id_is_404(authenticated_client: httpx.AsyncClient) -> None:
    response = await authenticated_client.patch("/api/materials/999999", json={"name": "Nope"})

    assert response.status_code == 404


async def test_delete_material_unknown_id_is_404(authenticated_client: httpx.AsyncClient) -> None:
    response = await authenticated_client.delete("/api/materials/999999")

    assert response.status_code == 404


async def test_delete_material_sets_print_material_id_null(
    authenticated_client: httpx.AsyncClient,
) -> None:
    material = (
        await authenticated_client.post("/api/materials", json={"name": "Deletable"})
    ).json()
    model = await _create_model(authenticated_client, "Material Delete SET NULL")
    created_print = (
        await authenticated_client.post(
            f"/api/models/{model['id']}/prints",
            json={"material_id": material["id"], "filament": "kept free text"},
        )
    ).json()

    response = await authenticated_client.delete(f"/api/materials/{material['id']}")
    assert response.status_code == 204

    listing = (await authenticated_client.get(f"/api/models/{model['id']}/prints")).json()
    row = next(p for p in listing if p["id"] == created_print["id"])
    assert row["material_id"] is None
    assert row["material"] is None
    assert row["filament"] == "kept free text"  # free-text snapshot survives

    materials = await authenticated_client.get("/api/materials")
    assert all(m["id"] != material["id"] for m in materials.json())


# ---------------------------------------------------------------------------
# print create/patch with material_id
# ---------------------------------------------------------------------------


async def test_create_print_with_material_id_embeds_material(
    authenticated_client: httpx.AsyncClient,
) -> None:
    material = (
        await authenticated_client.post(
            "/api/materials", json={"name": "Embedded PLA", "kind": "PLA", "color": "#ff0000"}
        )
    ).json()
    model = await _create_model(authenticated_client, "Print With Material")

    response = await authenticated_client.post(
        f"/api/models/{model['id']}/prints", json={"material_id": material["id"]}
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["material_id"] == material["id"]
    assert body["material"] == {
        "id": material["id"],
        "name": "Embedded PLA",
        "kind": "PLA",
        "color": "#ff0000",
    }


async def test_create_print_unknown_material_id_is_422(
    authenticated_client: httpx.AsyncClient,
) -> None:
    model = await _create_model(authenticated_client, "Print Unknown Material")

    response = await authenticated_client.post(
        f"/api/models/{model['id']}/prints", json={"material_id": 999999}
    )

    assert response.status_code == 422


async def test_patch_print_assigns_material_id(authenticated_client: httpx.AsyncClient) -> None:
    material = (
        await authenticated_client.post("/api/materials", json={"name": "Patch Me PLA"})
    ).json()
    model = await _create_model(authenticated_client, "Patch Print Material")
    created_print = (
        await authenticated_client.post(f"/api/models/{model['id']}/prints", json={})
    ).json()

    response = await authenticated_client.patch(
        f"/api/prints/{created_print['id']}", json={"material_id": material["id"]}
    )

    assert response.status_code == 200, response.text
    assert response.json()["material_id"] == material["id"]
    assert response.json()["material"]["name"] == "Patch Me PLA"
