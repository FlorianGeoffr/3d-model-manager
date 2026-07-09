import httpx
import pytest

from tests import corpus


@pytest.mark.asyncio
async def test_makerworld_import_is_rejected_pending_bambu_auth(
    authenticated_client, library_root, data_dir, monkeypatch
):
    """MakerWorld is no longer a deferred site (Workstream B task B1) -- a
    MakerWorld URL now builds the real importer and runs the normal import
    flow: fetch_metadata succeeds (this model isn't paid), but list_files
    raises the "needs a Bambu account" ImportRejected (downloads are B2)
    -- a clean FAILED row, never a crash, and no orphan model."""
    from app.importers import makerworld

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/design-service/design/999"
        return httpx.Response(
            200,
            json={
                "id": 999,
                "title": "MW Model",
                "summary": "a makerworld model",
                "designCreator": {"name": "mwuser"},
                "license": "Standard Digital File License",
                "coverUrl": "https://makerworld.bblmw.com/cover.jpg",
                "tags": ["gadget"],
                "isExclusive": False,
                "paidSetting": {"isPaid": False, "crowdfunding": 0},
            },
        )

    monkeypatch.setattr(
        makerworld,
        "_client",
        lambda: httpx.Client(
            base_url="https://makerworld.com/api/v1", transport=httpx.MockTransport(handler)
        ),
    )
    r = await authenticated_client.post(
        "/api/imports", json={"url": "https://makerworld.com/en/models/999"}
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["site"] == "makerworld" and body["external_id"] == "999"
    assert body["state"] == "failed" and body["model_id"] is None
    assert "Bambu" in body["error"]


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


@pytest.mark.asyncio
async def test_search_imports_dispatches_to_the_sites_importer(
    authenticated_client, library_root, data_dir, fake_import
):
    fake_import.title = "Searchable Fake"
    fake_import.external_id = "77"
    fake_import.author = "fakeuser"
    fake_import.cover_url = "https://fake.test/cover.png"
    r = await authenticated_client.get(
        "/api/imports/search", params={"site": "thingiverse", "q": "fake"}
    )
    assert r.status_code == 200, r.text
    assert r.json() == [
        {
            "site": "thingiverse",
            "external_id": "77",
            "title": "Searchable Fake",
            "url": "https://fake.test/thing/77",
            "author": "fakeuser",
            "thumbnail_url": "https://fake.test/cover.png",
        }
    ]


@pytest.mark.asyncio
async def test_search_imports_empty_query_returns_empty_list(
    authenticated_client, library_root, data_dir, fake_import
):
    r = await authenticated_client.get(
        "/api/imports/search", params={"site": "thingiverse", "q": "   "}
    )
    assert r.status_code == 200
    assert r.json() == []


@pytest.mark.asyncio
async def test_search_imports_rejects_unknown_site(authenticated_client, library_root, data_dir):
    r = await authenticated_client.get(
        "/api/imports/search", params={"site": "not-a-real-site", "q": "x"}
    )
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_search_imports_422_when_site_has_no_registered_importer(
    authenticated_client, library_root, data_dir, monkeypatch
):
    import app.api.imports as imports_api

    monkeypatch.setattr(imports_api, "get_importer", lambda site: None)
    r = await authenticated_client.get(
        "/api/imports/search", params={"site": "printables", "q": "benchy"}
    )
    assert r.status_code == 422
