import logging

import httpx
import pytest
from sqlalchemy import func, select

from app.importers import download
from app.importers.base import ResolvedDownload
from app.importers.fake import FAKE_DL, FakeImporter
from app.importers.registry import IMPORTER_REGISTRY
from app.models.enums import ImportSite, ImportState
from app.models.library import File, Model, Revision
from app.models.system import Import
from app.services import events, library
from app.tasks.importing import import_from_url
from tests import corpus

# `import_from_url` publishes SSE events over real Redis on every state
# transition (`_set_state` -> `events.publish_import_event_sync`) -- needs
# the session-scoped Redis testcontainer up before the FIRST test in this
# module runs the task, same as `tests/test_scanner.py`'s module-wide
# `usefixtures("redis_url")` (this module would otherwise only pass by
# accident of file ordering, when some other test file's `client` fixture
# happens to have started the container first).
pytestmark = pytest.mark.usefixtures("redis_url")


@pytest.mark.asyncio
async def test_download_failure_marks_failed_no_orphan_rows(
    db_session, library_root, data_dir, monkeypatch
):
    # A fake whose list_files advertises a file the transport 404s.
    fake = FakeImporter(files={"ghost.stl": b""})
    monkeypatch.setitem(IMPORTER_REGISTRY, ImportSite.THINGIVERSE, fake)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, text="gone")

    monkeypatch.setattr(
        download,
        "_download_client",
        lambda: httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True),
    )
    imp = Import(
        url="https://fake.test/thing/42",
        site=ImportSite.THINGIVERSE,
        external_id="42",
        state=ImportState.PENDING,
    )
    db_session.add(imp)
    await db_session.commit()
    await db_session.refresh(imp)

    import_from_url(imp.id)  # eager, sync

    await db_session.refresh(imp)
    assert imp.state == ImportState.FAILED and imp.model_id is None
    count = await db_session.scalar(select(func.count()).select_from(Model))
    assert count == 0


@pytest.mark.asyncio
async def test_download_failure_never_leaks_url_or_token_to_error_or_logs(
    db_session, library_root, data_dir, monkeypatch, caplog
):
    """FIX 1 (Critical): a real importer's resolved download URL can carry a
    signed token / access code. ``httpx.HTTPStatusError``'s own ``str()``
    echoes the full URL it hit -- that must never land in ``imports.error``
    nor in any log line."""
    fake = FakeImporter(files={"secret.stl": b""})
    monkeypatch.setitem(IMPORTER_REGISTRY, ImportSite.THINGIVERSE, fake)
    monkeypatch.setattr(
        fake,
        "resolve_download",
        lambda external_id, f: ResolvedDownload(
            url=f"{FAKE_DL}secret.stl?token=SECRETTOKEN123", filename=f.filename
        ),
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404, text="gone")

    monkeypatch.setattr(
        download,
        "_download_client",
        lambda: httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True),
    )
    imp = Import(
        url="https://fake.test/thing/42",
        site=ImportSite.THINGIVERSE,
        external_id="42",
        state=ImportState.PENDING,
    )
    db_session.add(imp)
    await db_session.commit()
    await db_session.refresh(imp)

    with caplog.at_level(logging.WARNING, logger="app.tasks.importing"):
        import_from_url(imp.id)

    await db_session.refresh(imp)
    assert imp.state == ImportState.FAILED and imp.model_id is None
    assert imp.error is not None
    assert "SECRETTOKEN123" not in imp.error
    assert "SECRETTOKEN123" not in caplog.text


@pytest.mark.asyncio
async def test_publish_failure_does_not_revert_a_successful_import(
    db_session, library_root, data_dir, fake_import, monkeypatch, caplog
):
    """FIX 2 (Critical): the DONE publish is best-effort -- a Redis blip
    during the final ``_set_state`` must not unwind an already-committed
    successful import into an orphaned model + a FAILED row."""
    fake_import.files = {"cube.stl": corpus.box_stl()}
    imp = Import(
        url="https://fake.test/thing/42",
        site=ImportSite.THINGIVERSE,
        external_id="42",
        state=ImportState.PENDING,
    )
    db_session.add(imp)
    await db_session.commit()
    await db_session.refresh(imp)

    def flaky_publish(redis_url, import_id, state):
        raise RuntimeError("simulated redis publish failure")

    monkeypatch.setattr(events, "publish_import_event_sync", flaky_publish)

    with caplog.at_level(logging.WARNING, logger="app.tasks.importing"):
        import_from_url(imp.id)

    await db_session.refresh(imp)
    assert imp.state == ImportState.DONE
    assert imp.model_id is not None
    count = await db_session.scalar(select(func.count()).select_from(Model))
    assert count == 1


@pytest.mark.asyncio
async def test_mid_download_failure_after_one_file_staged_leaves_no_orphans(
    db_session, library_root, data_dir, monkeypatch
):
    """FIX 3 (Important): a single-file 404 never proves the "file 1
    streamed, file 2 fails" ordering nor the spool-cleanup branch. Use a
    2-file fake: file A streams for real, file B 404s mid-loop."""
    fake = FakeImporter(files={"a.stl": corpus.box_stl(), "b.stl": b""})
    monkeypatch.setitem(IMPORTER_REGISTRY, ImportSite.THINGIVERSE, fake)

    def handler(request: httpx.Request) -> httpx.Response:
        name = str(request.url).removeprefix(FAKE_DL)
        if name == "a.stl":
            return httpx.Response(200, content=fake.files["a.stl"])
        return httpx.Response(404, text="gone")

    monkeypatch.setattr(
        download,
        "_download_client",
        lambda: httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True),
    )

    staged_paths = []
    original_stream = download.stream_remote_to_spool

    def spying_stream(*args, **kwargs):
        result = original_stream(*args, **kwargs)
        staged_paths.append(result.spool_path)
        return result

    monkeypatch.setattr(download, "stream_remote_to_spool", spying_stream)

    imp = Import(
        url="https://fake.test/thing/42",
        site=ImportSite.THINGIVERSE,
        external_id="42",
        state=ImportState.PENDING,
    )
    db_session.add(imp)
    await db_session.commit()
    await db_session.refresh(imp)

    import_from_url(imp.id)

    await db_session.refresh(imp)
    assert imp.state == ImportState.FAILED and imp.model_id is None
    assert len(staged_paths) == 1  # file A staged before file B's 404 aborted the loop
    assert not staged_paths[0].exists()  # the failure path must clean up staged spool files
    model_count = await db_session.scalar(select(func.count()).select_from(Model))
    revision_count = await db_session.scalar(select(func.count()).select_from(Revision))
    file_count = await db_session.scalar(select(func.count()).select_from(File))
    assert model_count == 0 and revision_count == 0 and file_count == 0


@pytest.mark.asyncio
async def test_store_failure_after_model_created_leaves_no_orphan_model(
    db_session, library_root, data_dir, fake_import, monkeypatch
):
    """FIX 4 (harden): ``create_imported_model_sync`` commits Model+Revision
    before the per-file store loop runs -- a failure there must not leave a
    committed orphan Model+Revision behind."""
    fake_import.files = {"cube.stl": corpus.box_stl()}

    def failing_store(*args, **kwargs):
        raise RuntimeError("simulated store failure")

    monkeypatch.setattr(library, "store_imported_file_sync", failing_store)

    imp = Import(
        url="https://fake.test/thing/42",
        site=ImportSite.THINGIVERSE,
        external_id="42",
        state=ImportState.PENDING,
    )
    db_session.add(imp)
    await db_session.commit()
    await db_session.refresh(imp)

    import_from_url(imp.id)

    await db_session.refresh(imp)
    assert imp.state == ImportState.FAILED and imp.model_id is None
    model_count = await db_session.scalar(select(func.count()).select_from(Model))
    revision_count = await db_session.scalar(select(func.count()).select_from(Revision))
    assert model_count == 0 and revision_count == 0
