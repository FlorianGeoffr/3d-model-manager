import httpx
import pytest

from app.importers import makerworld
from app.importers.base import ImportFile
from app.importers.makerworld import MakerWorldImporter
from app.models.enums import ImportSite
from app.tasks.importing import ImportRejected
from tests.cassettes import makerworld_fixtures as fx


@pytest.fixture(autouse=True)
def _truncate_all_tables():
    """Local no-op override of the suite-wide autouse DB-truncate fixture
    (conftest.py) -- every test in this module is DB-free (pure HTTP-mock /
    string parsing), same override as test_thingiverse_importer.py (M6 C3c)."""
    yield


def _mock_design_client(body, status=200):
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=body)

    return httpx.Client(
        base_url="https://makerworld.com/api/v1", transport=httpx.MockTransport(handler)
    )


def _mock_search_client(body):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/search-service/select/design"
        params = dict(request.url.params)
        assert params["q"] == fx.SEARCH_QUERY
        assert params["limit"] == "20" and params["offset"] == "0"
        return httpx.Response(200, json=body)

    return httpx.Client(
        base_url="https://makerworld.com/api/v1", transport=httpx.MockTransport(handler)
    )


@pytest.mark.parametrize(
    "url,expected",
    [
        ("https://makerworld.com/en/models/3018898-nasa-fabric-pokeball", "3018898"),
        ("https://www.makerworld.com/en/models/3018898", "3018898"),
        ("https://makerworld.com/de/models/42", "42"),
        ("https://makerworld.com/models/42", "42"),
        ("https://www.thingiverse.com/thing:1", None),
        ("https://makerworld.com/en/collections/17685211-x", None),
    ],
)
def test_canonicalize(url, expected):
    assert MakerWorldImporter().canonicalize(url) == expected


def test_fetch_metadata_maps_verified_fields(monkeypatch):
    monkeypatch.setattr(makerworld, "_client", lambda: _mock_design_client(fx.DESIGN_3018898))
    meta = MakerWorldImporter().fetch_metadata(fx.DESIGN_ID)
    assert meta.site is ImportSite.MAKERWORLD and meta.external_id == fx.DESIGN_ID
    assert meta.title == "NASA Fabric: Pokeball (No AMS Needed)"
    assert meta.source_url == "https://www.makerworld.com/en/models/3018898"
    assert meta.author == "MeasureOnce"
    assert meta.license == "Standard Digital File License"
    assert meta.cover_url == fx.DESIGN_3018898["coverUrl"]
    assert meta.description == fx.DESIGN_3018898["summary"]
    assert set(meta.tags) == set(fx.DESIGN_3018898["tags"])
    # isExclusive is True on this fixture (live-verified: ~90% of MakerWorld
    # designs are, unrelated to payment -- see makerworld.py's docstring) and
    # paidSetting.isPaid is False -- must NOT be rejected.
    assert meta.reject_reason is None


def test_paid_model_is_rejected_with_clear_message(monkeypatch):
    monkeypatch.setattr(makerworld, "_client", lambda: _mock_design_client(fx.DESIGN_PAID))
    meta = MakerWorldImporter().fetch_metadata(str(fx.DESIGN_PAID["id"]))
    assert meta.reject_reason and "paid" in meta.reject_reason.lower()


def test_search_maps_hits_to_search_results(monkeypatch):
    monkeypatch.setattr(makerworld, "_client", lambda: _mock_search_client(fx.SEARCH_DESIGN_BENCHY))
    results = MakerWorldImporter().search(fx.SEARCH_QUERY)
    assert [r.title for r in results] == [
        "NASA Fabric: Pokeball (No AMS Needed)",
        "12-in-1 Ultimate Multi Fidget Toy (Print in Place)",
    ]
    first = results[0]
    assert first.site is ImportSite.MAKERWORLD and first.external_id == "3018898"
    assert first.url == "https://www.makerworld.com/en/models/3018898"
    assert first.author == "MeasureOnce"
    assert first.thumbnail_url == fx.SEARCH_DESIGN_BENCHY["hits"][0]["cover"]


def test_search_empty_query_returns_empty_list():
    assert MakerWorldImporter().search("") == []


def test_list_files_raises_bambu_auth_required():
    with pytest.raises(ImportRejected, match="Bambu"):
        MakerWorldImporter().list_files(fx.DESIGN_ID)


def test_resolve_download_raises_bambu_auth_required():
    with pytest.raises(ImportRejected, match="Bambu"):
        MakerWorldImporter().resolve_download(
            fx.DESIGN_ID, ImportFile(remote_id="x", filename="x.stl")
        )
