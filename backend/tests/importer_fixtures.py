"""Import test fixtures (M5 carve-out). Wires a configurable FakeImporter
into the ImportSite registry AND points the download helper's client seam at
an httpx.MockTransport serving the fake's byte map -- so a full POST->task->
poll->model flow runs with ZERO real network. Registered from conftest's
pytest_plugins."""

from __future__ import annotations

import httpx
import pytest

from app.importers import download
from app.importers.fake import FAKE_DL, FakeImporter
from app.importers.registry import IMPORTER_REGISTRY
from app.models.enums import ImportSite


@pytest.fixture
def fake_import(monkeypatch: pytest.MonkeyPatch) -> FakeImporter:
    fake = FakeImporter()
    monkeypatch.setitem(IMPORTER_REGISTRY, ImportSite.THINGIVERSE, fake)

    def handler(request: httpx.Request) -> httpx.Response:
        name = str(request.url).removeprefix(FAKE_DL)
        if name in fake.files:
            return httpx.Response(200, content=fake.files[name])
        # T2: gallery-image bytes -- a SEPARATE map from `files` above (see
        # FakeImporter.image_bytes's docstring) so setting up an image
        # download in a test never also makes that image show up as one of
        # the model's own files via `list_files()`.
        if name in fake.image_bytes:
            return httpx.Response(200, content=fake.image_bytes[name])
        return httpx.Response(404, text="not found")

    monkeypatch.setattr(
        download,
        "_download_client",
        lambda: httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True),
    )
    return fake
