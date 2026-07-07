"""M5 full-stack offline flow (create-import -> poll -> model with files
appears). Real Postgres + Redis + Celery-eager + the real ingest/glb/thumb
pipeline run in-process; the ONLY mocked edge is the importer HTTP (fake
importer + httpx.MockTransport, via the `fake_import` fixture). This is the
offline analog of an e2e -- see the Task 7 gap note. NO real network."""

import pytest

from app.models.enums import ImportState
from app.models.system import Import
from app.tasks.base import sync_session
from tests import corpus


@pytest.mark.asyncio
async def test_import_produces_a_browsable_model_with_files(
    authenticated_client, library_root, data_dir, fake_import
):
    fake_import.title = "Imported Benchy"
    fake_import.author = "captain"
    fake_import.license = "CC-BY-4.0"
    fake_import.tags = ("boat", "calibration")
    fake_import.files = {"benchy.stl": corpus.box_stl(), "hollow.stl": corpus.box_obj()}

    created = await authenticated_client.post(
        "/api/imports", json={"url": "https://fake.test/thing/42"}
    )
    assert created.status_code == 201, created.text
    imp = created.json()
    assert imp["state"] == "done" and imp["model_id"] is not None  # eager => terminal

    # the import row records provenance meta (cover + selected files)
    assert imp["meta"]["files"] == ["benchy.stl", "hollow.stl"]

    # the model is in the gallery with attribution
    gallery = (await authenticated_client.get("/api/models")).json()["items"]
    row = next(m for m in gallery if m["name"] == "Imported Benchy")
    assert row["source_site"] == "thingiverse"

    # the model detail carries full provenance + a rev-001_imported revision
    # with both files (verified by the real store_to_backend pipeline)
    slug = row["slug"]
    detail = (await authenticated_client.get(f"/api/models/{slug}")).json()
    assert detail["source_author"] == "captain" and detail["source_license"] == "CC-BY-4.0"
    assert detail["source_url"] == "https://fake.test/thing/42"
    rev = detail["current_revision"]
    assert rev["dir_name"] == "rev-001_imported"
    assert sorted(f["rel_path"] for f in rev["files"]) == ["benchy.stl", "hollow.stl"]

    # the imports table has exactly one row and it points at the model
    with sync_session() as s:
        rows = s.query(Import).all()
        assert len(rows) == 1 and rows[0].state == ImportState.DONE
        assert rows[0].model_id == detail["id"]
