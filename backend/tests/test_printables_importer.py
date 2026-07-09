import json

import httpx
import pytest

from app.importers import printables
from app.importers.printables import PrintablesImporter
from app.models.enums import ImportSite
from tests.cassettes import printables_fixtures as fx


def _mock_client(print_body, link_body=None, search_body=None):
    def handler(request: httpx.Request) -> httpx.Response:
        payload = request.read().decode()
        if "searchPrints2" in payload:
            variables = json.loads(payload)["variables"]
            assert variables["query"] == fx.SEARCH_QUERY
            assert variables["limit"] == 20 and variables["offset"] == 0
            return httpx.Response(200, json=search_body or fx.SEARCH_PRINTS_BENCHY)
        if "getDownloadLink" in payload:
            # Guard the live getDownloadLink signature (it drifted once, and
            # the mock happily returns a link regardless of what we send): the
            # request MUST carry the current args -- printId, a model_detail
            # source, and files:[{fileType:"stl", ids:[...]}] with the
            # LOWERCASE enum. A future drift breaks this assert, not silently
            # ships a broken importer.
            variables = json.loads(payload)["variables"]
            assert variables["printId"] == fx.MODEL_ID
            assert variables["source"] == "model_detail"
            assert variables["files"] == [{"fileType": "stl", "ids": ["90001"]}]
            return httpx.Response(200, json=link_body or fx.DOWNLOAD_LINK_90001)
        return httpx.Response(200, json=print_body)

    return httpx.Client(
        base_url="https://api.printables.com/graphql/", transport=httpx.MockTransport(handler)
    )


@pytest.mark.parametrize(
    "url,expected",
    [
        ("https://www.printables.com/model/3161-benchy", "3161"),
        ("https://www.printables.com/en/model/3161", "3161"),
        ("https://thingiverse.com/thing:1", None),
    ],
)
def test_canonicalize(url, expected):
    assert PrintablesImporter().canonicalize(url) == expected


def test_fetch_metadata_free_model(monkeypatch):
    monkeypatch.setattr(printables, "_client", lambda: _mock_client(fx.PRINT_3161))
    meta = PrintablesImporter().fetch_metadata(fx.MODEL_ID)
    assert meta.site is ImportSite.PRINTABLES and meta.title == "Benchy"
    assert meta.author == "printables_user" and meta.license == "CC-BY-4.0"
    assert set(meta.tags) == {"boat", "calibration"}
    assert meta.cover_url.endswith("media/prints/3161/cover.png")
    assert meta.reject_reason is None


def test_premium_model_is_rejected_with_clear_message(monkeypatch):
    monkeypatch.setattr(printables, "_client", lambda: _mock_client(fx.PRINT_3161_PREMIUM))
    meta = PrintablesImporter().fetch_metadata(fx.MODEL_ID)
    assert meta.reject_reason and "paid" in meta.reject_reason.lower()


def test_list_files_from_stls(monkeypatch):
    monkeypatch.setattr(printables, "_client", lambda: _mock_client(fx.PRINT_3161))
    files = PrintablesImporter().list_files(fx.MODEL_ID)
    assert [f.filename for f in files] == ["3DBenchy.stl", "3DBenchy_hollow.stl"]
    assert files[0].remote_id == "90001"


def test_resolve_download_returns_cdn_link(monkeypatch):
    monkeypatch.setattr(printables, "_client", lambda: _mock_client(fx.PRINT_3161))
    from app.importers.base import ImportFile

    out = PrintablesImporter().resolve_download(
        fx.MODEL_ID, ImportFile(remote_id="90001", filename="3DBenchy.stl")
    )
    assert out.url.startswith("https://files.printables.com/media/dl/3161/3DBenchy.stl")


def test_search_maps_hits_to_search_results(monkeypatch):
    monkeypatch.setattr(printables, "_client", lambda: _mock_client(fx.PRINT_3161))
    results = PrintablesImporter().search(fx.SEARCH_QUERY)
    assert [r.title for r in results] == ["3D BENCHY", "All Terrain Assault Benchy"]
    first = results[0]
    assert first.site is ImportSite.PRINTABLES and first.external_id == "3161"
    assert first.url == "https://www.printables.com/model/3161"
    assert first.author == "Prusa Research"
    assert first.thumbnail_url.endswith("media/prints/3161/images/20206_70fde6a0/benchy.jpg")


def test_search_empty_query_returns_empty_list_without_a_request(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("search() must not make a request for an empty query")

    monkeypatch.setattr(
        printables,
        "_client",
        lambda: httpx.Client(
            base_url="https://api.printables.com/graphql/", transport=httpx.MockTransport(handler)
        ),
    )
    assert PrintablesImporter().search("") == []


@pytest.mark.live_importer
def test_live_printables_metadata():
    """Deferred/manual live smoke (SPEC "one live smoke"), excluded from the
    default gate. Run with `-m live_importer`; hits the real GraphQL API.

    Printables is anonymous (no token to naturally gate this on, unlike the
    Thingiverse live smoke), and `-m 'not e2e'` in pyproject's `addopts`
    does not deselect `live_importer` until Task 7's addopts change lands --
    so an explicit opt-in env var keeps this test from making a real network
    call every time the default `uv run pytest` gate runs.
    """
    import os

    if not os.environ.get("TDMM_LIVE_PRINTABLES"):
        pytest.skip("set TDMM_LIVE_PRINTABLES=1 to run the live smoke")
    meta = PrintablesImporter().fetch_metadata(fx.MODEL_ID)
    assert meta.title and meta.external_id == fx.MODEL_ID
