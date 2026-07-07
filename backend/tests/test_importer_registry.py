from app.importers.base import ImportFile, ImportMetadata, safe_filename
from app.importers.fake import FAKE_BASE, FakeImporter
from app.importers.registry import (
    IMPORTER_REGISTRY,
    build_importer_for_url,
    deferred_site_for_url,
    register_importer,
)
from app.models.enums import ImportSite


def test_build_importer_for_url_detects_and_extracts(monkeypatch):
    fake = FakeImporter(external_id="99")
    monkeypatch.setitem(IMPORTER_REGISTRY, ImportSite.THINGIVERSE, fake)
    chosen = build_importer_for_url(f"{FAKE_BASE}99")
    assert chosen is fake
    assert chosen.canonicalize(f"{FAKE_BASE}99") == "99"


def test_build_importer_for_url_unknown_is_none():
    assert build_importer_for_url("https://example.com/whatever") is None


def test_makerworld_url_is_detected_as_deferred_not_crashing():
    assert build_importer_for_url("https://makerworld.com/en/models/123") is None
    assert deferred_site_for_url("https://makerworld.com/en/models/123") is ImportSite.MAKERWORLD
    assert deferred_site_for_url("https://www.thingiverse.com/thing:763622") is None


def test_register_importer_keys_on_site(monkeypatch):
    monkeypatch.setitem(IMPORTER_REGISTRY, ImportSite.THINGIVERSE, FakeImporter())
    out = register_importer(FakeImporter(title="second"))
    assert IMPORTER_REGISTRY[ImportSite.THINGIVERSE] is out


def test_fake_metadata_and_files_shape():
    fake = FakeImporter(files={"cube.stl": b"solid\n"})
    meta = fake.fetch_metadata("42")
    assert isinstance(meta, ImportMetadata) and meta.title == "Fake Thing"
    files = fake.list_files("42")
    assert files == [
        ImportFile(
            remote_id="cube.stl", filename="cube.stl", url="https://fake.test/dl/cube.stl", size=6
        )
    ]


def test_safe_filename_strips_paths_and_dots():
    assert safe_filename("../../etc/passwd") == "passwd"
    assert safe_filename("a/b/c.stl") == "c.stl"
    assert safe_filename("") == "file"
