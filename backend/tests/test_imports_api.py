import pytest

from tests import corpus


@pytest.mark.asyncio
async def test_makerworld_url_is_rejected_not_crashed(authenticated_client, library_root, data_dir):
    r = await authenticated_client.post(
        "/api/imports", json={"url": "https://makerworld.com/en/models/999"}
    )
    assert r.status_code == 422 and "MakerWorld" in r.json()["detail"]


@pytest.mark.asyncio
async def test_unsupported_url_is_rejected(authenticated_client, library_root, data_dir):
    r = await authenticated_client.post("/api/imports", json={"url": "https://example.com/x"})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_full_import_flow_creates_model(
    authenticated_client, library_root, data_dir, fake_import
):
    fake_import.files = {"cube.stl": corpus.box_stl()}
    r = await authenticated_client.post("/api/imports", json={"url": "https://fake.test/thing/42"})
    assert r.status_code == 201, r.text
    body = r.json()
    # eager task ran inline -> already terminal
    assert body["state"] == "done" and body["model_id"] is not None
    assert body["site"] == "thingiverse" and body["external_id"] == "42"

    poll = await authenticated_client.get(f"/api/imports/{body['id']}")
    assert poll.json()["state"] == "done"

    gallery = await authenticated_client.get("/api/models")
    names = [m["name"] for m in gallery.json()["items"]]
    assert "Fake Thing" in names


@pytest.mark.asyncio
async def test_rejected_import_leaves_no_model(
    authenticated_client, library_root, data_dir, fake_import
):
    fake_import.reject_reason = "This is a paid model and can't be imported"
    fake_import.files = {"cube.stl": corpus.box_stl()}
    r = await authenticated_client.post("/api/imports", json={"url": "https://fake.test/thing/42"})
    assert r.status_code == 201
    body = r.json()
    assert body["state"] == "failed" and body["model_id"] is None
    assert "paid" in body["error"]
    # atomicity: no model created
    gallery = await authenticated_client.get("/api/models")
    assert gallery.json()["items"] == []
