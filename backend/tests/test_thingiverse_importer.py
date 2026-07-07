import httpx
import pytest

from app.importers import thingiverse
from app.importers.base import ImportFile
from app.importers.thingiverse import ThingiverseImporter
from app.models.enums import ImportSite
from tests.cassettes import thingiverse_fixtures as fx


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


def test_resolve_download_adds_bearer(monkeypatch):
    monkeypatch.setattr(thingiverse, "_token", lambda: "tok-xyz")
    out = ThingiverseImporter().resolve_download(
        fx.THING_ID,
        ImportFile(
            remote_id="Marvin.stl",
            filename="Marvin.stl",
            url="https://cdn.thingiverse.com/assets/aa/marvin.stl",
        ),
    )
    assert out.url == "https://cdn.thingiverse.com/assets/aa/marvin.stl"
    assert out.headers == {"Authorization": "Bearer tok-xyz"}


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
