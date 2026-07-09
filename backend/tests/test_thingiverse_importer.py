import httpx
import pytest

from app.importers import thingiverse
from app.importers.base import ImportFile
from app.importers.thingiverse import ThingiverseImporter
from app.models.enums import ImportSite
from tests.cassettes import thingiverse_fixtures as fx


@pytest.fixture(autouse=True)
def _truncate_all_tables():
    """Local no-op override of the suite-wide autouse DB-truncate fixture
    (conftest.py) -- every test in this module is DB-free (pure HTTP-mock /
    string parsing), so skip pulling in ``migrated_db``/``postgres_url`` and
    the Postgres container they spin up (M6 C3c). autouse must be
    re-declared on the override for pytest to prefer it here."""
    yield


def _mock_client(cassette):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == f"/things/{fx.THING_ID}"
        return httpx.Response(200, json=cassette)

    return httpx.Client(
        base_url="https://api.thingiverse.com", transport=httpx.MockTransport(handler)
    )


@pytest.fixture
def imp(monkeypatch):
    monkeypatch.setattr(thingiverse, "_client", lambda token=None: _mock_client(fx.THING_763622))
    return ThingiverseImporter()


@pytest.mark.parametrize(
    "url,expected",
    [
        ("https://www.thingiverse.com/thing:763622", "763622"),
        ("https://www.thingiverse.com/thing:763622/files", "763622"),
        ("https://example.com/nope", None),
        ("https://thingiverse.com/thing:5", "5"),
        ("https://notthingiverse.com/thing:5", None),
        ("https://example.com/x", None),
    ],
)
def test_canonicalize(url, expected):
    assert ThingiverseImporter().canonicalize(url) == expected


def test_fetch_metadata_normalizes(imp):
    meta = imp.fetch_metadata(fx.THING_ID)
    assert meta.site is ImportSite.THINGIVERSE and meta.title == "Marvin (keychain)"
    assert meta.author == "makerbot"
    assert meta.license == "CC-BY-4.0"  # mapped from "Creative Commons - Attribution"
    assert meta.cover_url == "https://cdn.thingiverse.com/renders/cover.jpg"
    assert set(meta.tags) == {"keychain", "marvin"}
    assert meta.reject_reason is None


def test_list_files_from_zip_data(imp):
    files = imp.list_files(fx.THING_ID)
    assert [f.filename for f in files] == ["Marvin.stl", "Marvin_v2.stl"]
    assert files[0].url == "https://cdn.thingiverse.com/assets/aa/marvin.stl"


def test_resolve_download_uses_public_cdn_url():
    # zip_data.files[].url are public CDN assets -- resolve_download returns
    # the URL with NO Authorization header (we must not leak the app token to
    # the CDN, and it isn't needed).
    out = ThingiverseImporter().resolve_download(
        fx.THING_ID,
        ImportFile(
            remote_id="Marvin.stl",
            filename="Marvin.stl",
            url="https://cdn.thingiverse.com/assets/aa/marvin.stl",
        ),
    )
    assert out.url == "https://cdn.thingiverse.com/assets/aa/marvin.stl"
    assert out.headers == {}


def test_search_without_a_token_returns_empty_list(monkeypatch):
    # No app token configured -- Thingiverse's search endpoint is
    # token-gated like everything else on this API, so search() must
    # degrade to [] rather than raise (SPEC "importers that can't search
    # may return []"). Assert it doesn't even try to build a client.
    monkeypatch.setattr(thingiverse, "_token", lambda: None)

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("search() must not make a request with no token")

    monkeypatch.setattr(
        thingiverse,
        "_client",
        lambda token=None: httpx.Client(transport=httpx.MockTransport(handler)),
    )
    assert ThingiverseImporter().search(fx.SEARCH_TERM) == []


def test_search_maps_hits_to_search_results(monkeypatch):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == f"/search/{fx.SEARCH_TERM}"
        params = dict(request.url.params)
        assert params == {"type": "things", "per_page": "20", "page": "1"}
        return httpx.Response(200, json=fx.SEARCH_MARVIN)

    monkeypatch.setattr(thingiverse, "_token", lambda: "tok")
    monkeypatch.setattr(
        thingiverse,
        "_client",
        lambda token=None: httpx.Client(
            base_url="https://api.thingiverse.com", transport=httpx.MockTransport(handler)
        ),
    )
    results = ThingiverseImporter().search(fx.SEARCH_TERM)
    assert [r.title for r in results] == ["Marvin (keychain)", "Marvin the Robot"]
    first = results[0]
    assert first.site is ImportSite.THINGIVERSE and first.external_id == "763622"
    assert first.url == "https://www.thingiverse.com/thing:763622"
    assert first.author == "makerbot"
    assert first.thumbnail_url == "https://cdn.thingiverse.com/renders/cover.jpg"


def test_search_empty_query_returns_empty_list():
    assert ThingiverseImporter().search("") == []


@pytest.mark.live_importer
def test_live_thingiverse_metadata():
    """Deferred/manual live smoke (SPEC "one live smoke"). Excluded from the
    default gate by the -m in pyproject; run with `-m live_importer` and a
    TDMM_THINGIVERSE_TOKEN in the environment. Never runs in CI."""
    import os

    token = os.environ.get("TDMM_THINGIVERSE_TOKEN")
    if not token:
        pytest.skip("set TDMM_THINGIVERSE_TOKEN to run the live smoke")
    import app.importers.thingiverse as tv

    monkey = pytest.MonkeyPatch()
    monkey.setattr(tv, "_token", lambda: token)
    try:
        importer = tv.ThingiverseImporter()
        meta = importer.fetch_metadata(fx.THING_ID)
        assert meta.title and meta.external_id == fx.THING_ID
        # Guards the zip_data assumption (SPEC/FULL line 228): if the live API
        # doesn't nest files/images under zip_data, these fail first.
        assert importer.list_files(fx.THING_ID)
        assert meta.cover_url is not None
    finally:
        monkey.undo()
